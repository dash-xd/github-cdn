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
                        err.status = 409;
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
