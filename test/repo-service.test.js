"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    commitFiles,
    deleteFiles,
    getBranchSnapshot
} = require("../src/lib/repo-service.js");

function response(data) {
    return { data };
}

function makeObject(index) {
    const objectId = index.toString(16).padStart(64, "0");
    return {
        objectId,
        path: `objects/${objectId.slice(0, 2)}/${objectId}`,
        originalName: `asset-${index}.bin`,
        contentType: "application/octet-stream",
        size: 1,
        content: Buffer.from([index])
    };
}

function createConcurrentGit() {
    let currentHead = "commit-0";
    let nextId = 1;

    const commits = new Map([
        ["commit-0", { tree: "tree-0", parent: null }]
    ]);
    const trees = new Map([
        ["tree-0", new Map()]
    ]);

    const octokit = {
        rest: {
            git: {
                getRef: async () => response({ object: { sha: currentHead } }),
                getCommit: async ({ commit_sha }) => response({
                    tree: { sha: commits.get(commit_sha).tree }
                }),
                createBlob: async () => response({ sha: `blob-${nextId++}` }),
                getTree: async ({ tree_sha }) => response({
                    tree: [...trees.get(tree_sha)].map(([path, sha]) => ({
                        path,
                        type: "blob",
                        sha
                    })),
                    truncated: false
                }),
                createTree: async ({ base_tree, tree }) => {
                    const entries = new Map(trees.get(base_tree));

                    for (const entry of tree) {
                        if (entry.sha === null) {
                            entries.delete(entry.path);
                        } else {
                            entries.set(entry.path, entry.sha);
                        }
                    }

                    const sha = `tree-${nextId++}`;
                    trees.set(sha, entries);
                    return response({ sha });
                },
                createCommit: async ({ tree, parents }) => {
                    const sha = `commit-${nextId++}`;
                    commits.set(sha, {
                        tree,
                        parent: parents[0]
                    });
                    return response({ sha });
                },
                updateRef: async ({ sha }) => {
                    // Force competing writers to overlap before deciding who won.
                    await new Promise((resolve) => setImmediate(resolve));

                    const candidate = commits.get(sha);
                    if (candidate.parent !== currentHead) {
                        const err = new Error("Update is not a fast forward");
                        err.status = 422;
                        throw err;
                    }

                    currentHead = sha;
                    return response({});
                }
            }
        }
    };

    return {
        octokit,
        snapshot() {
            return new Map(trees.get(commits.get(currentHead).tree));
        }
    };
}

test("commitFiles retries from the new branch head after a ref race", async () => {
    let currentHead = "commit-a";
    let updateAttempts = 0;
    const createdParents = [];
    const baseTrees = [];

    const octokit = {
        rest: {
            git: {
                getRef: async () => response({ object: { sha: currentHead } }),
                getCommit: async ({ commit_sha }) => response({ tree: { sha: `tree-${commit_sha}` } }),
                createBlob: async () => response({ sha: "blob-1" }),
                getTree: async () => response({ tree: [], truncated: false }),
                createTree: async ({ base_tree }) => {
                    baseTrees.push(base_tree);
                    return response({ sha: `new-${base_tree}` });
                },
                createCommit: async ({ parents }) => {
                    createdParents.push(parents[0]);
                    return response({ sha: `candidate-${parents[0]}` });
                },
                updateRef: async () => {
                    updateAttempts += 1;
                    if (updateAttempts === 1) {
                        currentHead = "commit-b";
                        const err = new Error("Update is not a fast forward");
                        err.status = 422;
                        throw err;
                    }
                    return response({});
                }
            }
        }
    };

    const result = await commitFiles(octokit, "owner", "repo", "cdn", [{
        objectId: "a".repeat(64),
        path: `objects/aa/${"a".repeat(64)}`,
        originalName: "asset.bin",
        contentType: "application/octet-stream",
        size: 3,
        content: Buffer.from("abc")
    }]);

    assert.equal(result.commit, "candidate-commit-b");
    assert.equal(updateAttempts, 2);
    assert.deepEqual(createdParents, ["commit-a", "commit-b"]);
    assert.deepEqual(baseTrees, ["tree-commit-a", "tree-commit-b"]);
});

test("deleteFiles applies sparse tombstones to the exact current base tree", async () => {
    let getTreeCalled = false;
    let createTreeArgs;

    const octokit = {
        rest: {
            git: {
                getRef: async () => response({ object: { sha: "commit-a" } }),
                getCommit: async () => response({ tree: { sha: "tree-a" } }),
                getTree: async () => {
                    getTreeCalled = true;
                    throw new Error("deleteFiles must not enumerate the branch");
                },
                createTree: async (args) => {
                    createTreeArgs = args;
                    return response({ sha: "tree-b" });
                },
                createCommit: async ({ tree, parents }) => {
                    assert.equal(tree, "tree-b");
                    assert.deepEqual(parents, ["commit-a"]);
                    return response({ sha: "commit-b" });
                },
                updateRef: async ({ sha, force }) => {
                    assert.equal(sha, "commit-b");
                    assert.equal(force, false);
                    return response({});
                }
            }
        }
    };

    await deleteFiles(octokit, "owner", "repo", "cdn", ["objects/aa/one", "objects/bb/two"]);

    assert.equal(getTreeCalled, false);
    assert.equal(createTreeArgs.base_tree, "tree-a");
    assert.deepEqual(createTreeArgs.tree, [
        { path: "objects/aa/one", mode: "100644", type: "blob", sha: null },
        { path: "objects/bb/two", mode: "100644", type: "blob", sha: null }
    ]);
});

test("getBranchSnapshot fails closed when GitHub truncates a recursive tree", async () => {
    const octokit = {
        rest: {
            git: {
                getRef: async () => response({ object: { sha: "commit-a" } }),
                getCommit: async () => response({ tree: { sha: "tree-a" } }),
                getTree: async () => response({
                    tree: [{ path: "objects/aa/one", type: "blob", sha: "blob-a" }],
                    truncated: true
                })
            }
        }
    };

    await assert.rejects(
        getBranchSnapshot(octokit, "owner", "repo", "cdn"),
        (err) => err.status === 413 && /recursive tree response limit/.test(err.message)
    );
});

test("concurrent uploads and deletes preserve the successful object union", async () => {
    const git = createConcurrentGit();

    const initial = [0, 1, 2, 3, 4].map(makeObject);
    await commitFiles(git.octokit, "owner", "repo", "cdn", initial);

    const uploads = Array.from({ length: 20 }, (_, index) => makeObject(index + 10));
    const deletePaths = [initial[1].path, initial[3].path];

    await Promise.all([
        ...uploads.map((object) =>
            commitFiles(git.octokit, "owner", "repo", "cdn", [object])
        ),
        ...deletePaths.map((path) =>
            deleteFiles(git.octokit, "owner", "repo", "cdn", [path])
        )
    ]);

    const finalPaths = [...git.snapshot().keys()].sort();
    const expectedPaths = [
        ...initial.filter((object) => !deletePaths.includes(object.path)),
        ...uploads
    ].map((object) => object.path).sort();

    assert.deepEqual(finalPaths, expectedPaths);
});
