"use strict";

const { randomUUID } = require("node:crypto");

function sanitizeName(name) {
    const cleaned = String(name)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return cleaned || "repo";
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

// Like createRepo, but org-owned: a personal access token creates under
// the token owner's account (POST /user/repos), which has no equivalent
// for "create this under an org I belong to" - that has to go through
// POST /orgs/{org}/repos instead, with the org named explicitly.
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

// Writes each uploaded file to its content-addressed path (see
// middleware/upload.js#objectPath) in a single commit. Storage identity
// comes from the content hash, not the caller-supplied filename, so
// re-uploading the same bytes is idempotent: same hash, same path.
async function commitFiles(octokit, owner, repo, branch, files) {
    if (!files || files.length === 0) {
        throw new Error("no files to upload");
    }

    const targetBranch = branch || (await getDefaultBranch(octokit, owner, repo));

    const ref = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${targetBranch}`
    });

    // `base_tree` must be a tree SHA, not the commit SHA the ref points at.
    const parentCommit = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: ref.data.object.sha
    });

    // Several uploaded files can hash to the same object; write each
    // distinct one once, but still report every requested file below.
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

    const tree = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: parentCommit.data.tree.sha,
        tree: blobs
    });

    const commit = await octokit.rest.git.createCommit({
        owner,
        repo,
        message: `store ${uniqueObjects.size} object${uniqueObjects.size === 1 ? "" : "s"}`,
        tree: tree.data.sha,
        parents: [ref.data.object.sha]
    });

    await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${targetBranch}`,
        sha: commit.data.sha
    });

    return {
        repo,
        branch: targetBranch,
        commit: commit.data.sha,
        objects: files.map((file) => ({
            objectId: file.objectId,
            path: file.path,
            name: file.originalName,
            contentType: file.contentType,
            size: file.size
        }))
    };
}

// Snapshot a branch's file tree via the Git Data API instead of `git clone`.
// Pass includeContent to also fetch each blob's base64 content.
async function getBranchSnapshot(octokit, owner, repo, branch, { includeContent = false } = {}) {
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

    const tree = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: commit.data.tree.sha,
        recursive: "true"
    });

    const entries = tree.data.tree.filter((entry) => entry.type === "blob");

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

    const toDelete = new Set(paths);

    // Only keep blob entries: passing full slash-separated paths (no base_tree)
    // lets the Git Data API rebuild intermediate directory trees for us.
    const snapshot = await getBranchSnapshot(octokit, owner, repo, branch);
    const remaining = snapshot
        .filter((entry) => !toDelete.has(entry.path))
        .map((entry) => ({
            path: entry.path,
            mode: entry.mode,
            type: "blob",
            sha: entry.sha
        }));

    if (remaining.length === snapshot.length) {
        throw new Error("none of the given paths exist on this branch");
    }

    const ref = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`
    });

    const newTree = await octokit.rest.git.createTree({
        owner,
        repo,
        tree: remaining
    });

    const commit = await octokit.rest.git.createCommit({
        owner,
        repo,
        message: `delete ${paths.length} object${paths.length === 1 ? "" : "s"}`,
        tree: newTree.data.sha,
        parents: [ref.data.object.sha]
    });

    await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha
    });

    return { repo, branch, commit: commit.data.sha };
}

// A truly empty branch: an orphan commit with no tree entries and no parents.
async function createEmptyBranch(octokit, owner, repo, branch) {
    // GitHub rejects createTree({ tree: [] }). Build a valid empty tree by
    // starting from the default branch's tree and deleting every leaf entry.
    const defaultBranch = await getDefaultBranch(octokit, owner, repo);
    const baseRef = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`
    });

    const baseCommit = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: baseRef.data.object.sha
    });

    const baseTree = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: baseCommit.data.tree.sha,
        recursive: "true"
    });

    const deletions = baseTree.data.tree
        .filter((entry) => entry.type !== "tree")
        .map((entry) => ({
            path: entry.path,
            mode: entry.mode,
            type: entry.type,
            sha: null
        }));

    let treeSha = baseCommit.data.tree.sha;

    if (deletions.length > 0) {
        const emptyTree = await octokit.rest.git.createTree({
            owner,
            repo,
            base_tree: baseCommit.data.tree.sha,
            tree: deletions
        });

        treeSha = emptyTree.data.sha;
    }

    const commit = await octokit.rest.git.createCommit({
        owner,
        repo,
        message: "initialize empty branch",
        tree: treeSha,
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
