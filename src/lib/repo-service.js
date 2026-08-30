"use strict";

const { randomUUID } = require("node:crypto");

const EMPTY_BRANCH_MARKER = ".github-cdn-empty-tree";
const MAX_REF_UPDATE_ATTEMPTS = 12;
const MAX_REF_RETRY_DELAY_MS = 100;

function sanitizeName(name) {
    const cleaned = String(name)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return cleaned || "repo";
}

function isRefConflict(err) {
    return err?.status === 409 || err?.status === 422;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backoffRefConflict(attempt) {
    const ceiling = Math.min(MAX_REF_RETRY_DELAY_MS, 2 ** (attempt - 1));
    const delay = Math.floor(Math.random() * (ceiling + 1));
    await sleep(delay);
}

async function createRepo(octokit, name, options = {}) {
    const repoName = `${sanitizeName(name)}-${randomUUID().slice(0, 8)}`;

    const { data } = await octokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        private: options.private ?? true,
        auto_init: true
    });

    return data;
}

async function getDefaultBranch(octokit, owner, repo) {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return data.default_branch;
}

async function createOrgRepo(octokit, org, name, options = {}) {
    const repoName = `${sanitizeName(name)}-${randomUUID().slice(0, 8)}`;

    const { data } = await octokit.rest.repos.createInOrg({
        org,
        name: repoName,
        private: options.private ?? true,
        auto_init: true
    });

    return data;
}

async function getBranchHead(octokit, owner, repo, branch) {
    const ref = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`
    });

    const commit = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: ref.data.object.sha
    });

    return {
        commitSha: ref.data.object.sha,
        treeSha: commit.data.tree.sha
    };
}

async function updateBranchOptimistically(octokit, owner, repo, branch, buildCommit) {
    let lastConflict;

    for (let attempt = 1; attempt <= MAX_REF_UPDATE_ATTEMPTS; attempt += 1) {
        const head = await getBranchHead(octokit, owner, repo, branch);
        const commitSha = await buildCommit(head);

        try {
            await octokit.rest.git.updateRef({
                owner,
                repo,
                ref: `heads/${branch}`,
                sha: commitSha,
                force: false
            });

            return commitSha;
        } catch (err) {
            if (!isRefConflict(err) || attempt === MAX_REF_UPDATE_ATTEMPTS) {
                throw err;
            }
            lastConflict = err;
            await backoffRefConflict(attempt);
        }
    }

    throw lastConflict || new Error("failed to update branch ref");
}

async function commitFiles(octokit, owner, repo, branch, files) {
    if (!files || files.length === 0) {
        throw new Error("no files to upload");
    }

    const targetBranch = branch || (await getDefaultBranch(octokit, owner, repo));

    const uniqueObjects = new Map();
    for (const file of files) {
        if (!uniqueObjects.has(file.objectId)) {
            uniqueObjects.set(file.objectId, file);
        }
    }

    const blobs = [];
    for (const object of uniqueObjects.values()) {
        const blob = await octokit.rest.git.createBlob({
            owner,
            repo,
            content: object.content.toString("base64"),
            encoding: "base64"
        });

        blobs.push({
            path: object.path,
            mode: "100644",
            type: "blob",
            sha: blob.data.sha
        });
    }

    const commitSha = await updateBranchOptimistically(
        octokit,
        owner,
        repo,
        targetBranch,
        async ({ commitSha: parentSha, treeSha }) => {
            const parentTree = await octokit.rest.git.getTree({
                owner,
                repo,
                tree_sha: treeSha
            });

            const treeEntries = [...blobs];

            if (parentTree.data.tree.some((entry) => entry.path === EMPTY_BRANCH_MARKER)) {
                treeEntries.push({
                    path: EMPTY_BRANCH_MARKER,
                    mode: "100644",
                    type: "blob",
                    sha: null
                });
            }

            const tree = await octokit.rest.git.createTree({
                owner,
                repo,
                base_tree: treeSha,
                tree: treeEntries
            });

            const commit = await octokit.rest.git.createCommit({
                owner,
                repo,
                message: `store ${uniqueObjects.size} object${uniqueObjects.size === 1 ? "" : "s"}`,
                tree: tree.data.sha,
                parents: [parentSha]
            });

            return commit.data.sha;
        }
    );

    return {
        repo,
        branch: targetBranch,
        commit: commitSha,
        objects: files.map((file) => ({
            objectId: file.objectId,
            path: file.path,
            name: file.originalName,
            contentType: file.contentType,
            size: file.size
        }))
    };
}

async function getBranchSnapshot(octokit, owner, repo, branch, { includeContent = false } = {}) {
    const { treeSha } = await getBranchHead(octokit, owner, repo, branch);

    const tree = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: treeSha,
        recursive: "true"
    });

    if (tree.data.truncated) {
        const err = new Error("branch tree exceeds GitHub's recursive tree response limit");
        err.status = 413;
        throw err;
    }

    const entries = tree.data.tree.filter(
        (entry) => entry.type === "blob" && entry.path !== EMPTY_BRANCH_MARKER
    );

    if (!includeContent) {
        return entries;
    }

    const files = [];
    for (const entry of entries) {
        const blob = await octokit.rest.git.getBlob({
            owner,
            repo,
            file_sha: entry.sha
        });

        files.push({
            path: entry.path,
            mode: entry.mode,
            sha: entry.sha,
            encoding: blob.data.encoding,
            content: blob.data.content
        });
    }

    return files;
}

async function deleteFiles(octokit, owner, repo, branch, paths) {
    if (!paths || paths.length === 0) {
        throw new Error("no paths to delete");
    }

    const uniquePaths = [...new Set(paths)];

    const commitSha = await updateBranchOptimistically(
        octokit,
        owner,
        repo,
        branch,
        async ({ commitSha: parentSha, treeSha }) => {
            const deletions = uniquePaths.map((path) => ({
                path,
                mode: "100644",
                type: "blob",
                sha: null
            }));

            const newTree = await octokit.rest.git.createTree({
                owner,
                repo,
                base_tree: treeSha,
                tree: deletions
            });

            if (newTree.data.sha === treeSha) {
                const err = new Error("none of the given paths exist on this branch");
                err.status = 404;
                throw err;
            }

            const commit = await octokit.rest.git.createCommit({
                owner,
                repo,
                message: `delete ${uniquePaths.length} object${uniquePaths.length === 1 ? "" : "s"}`,
                tree: newTree.data.sha,
                parents: [parentSha]
            });

            return commit.data.sha;
        }
    );

    return { repo, branch, commit: commitSha, requested: uniquePaths.length };
}

async function createEmptyBranch(octokit, owner, repo, branch) {
    const tree = await octokit.rest.git.createTree({
        owner,
        repo,
        tree: [{
            path: EMPTY_BRANCH_MARKER,
            mode: "100644",
            type: "blob",
            content: ""
        }]
    });

    const commit = await octokit.rest.git.createCommit({
        owner,
        repo,
        message: "initialize empty branch",
        tree: tree.data.sha,
        parents: []
    });

    await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: commit.data.sha
    });

    return { repo, branch, commit: commit.data.sha };
}

async function createBranchFrom(octokit, owner, repo, newBranch, sourceBranch) {
    const source = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${sourceBranch}`
    });

    await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${newBranch}`,
        sha: source.data.object.sha
    });

    return { repo, branch: newBranch, from: sourceBranch, sha: source.data.object.sha };
}

module.exports = {
    createRepo,
    createOrgRepo,
    getDefaultBranch,
    commitFiles,
    getBranchSnapshot,
    deleteFiles,
    createEmptyBranch,
    createBranchFrom
};
