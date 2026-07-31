"use strict";

const { SimpleRouterBuilder, NewEmptyRouter } = require("simple-router-builder");

const { createOctokit } = require("./src/lib/client.js");
const { githubAuth } = require("./src/middleware/github-auth.js");
const { parseUpload } = require("./src/middleware/upload.js");
const {
    createRepoHandler,
    uploadObjectsHandler,
    getBranchSnapshotHandler,
    deleteObjectsHandler,
    createEmptyBranchHandler,
    createBranchFromHandler,
    handleError
} = require("./src/middleware/github-repos.js");

// One Octokit instance per token, reused for the lifetime of this warm
// function instance instead of being rebuilt on every request.
const octokitByToken = new Map();

function lazyCreateOctokit(token) {
    let octokit = octokitByToken.get(token);

    if (!octokit) {
        octokit = createOctokit(token);
        octokitByToken.set(token, octokit);
    }

    return octokit;
}

const githubRouter = NewEmptyRouter()
    .use(githubAuth(lazyCreateOctokit))
    .post("/repos/:name", createRepoHandler)
    .post("/repos/:owner/:repo/upload", parseUpload, uploadObjectsHandler)
    .get("/repos/:owner/:repo/:branch", getBranchSnapshotHandler)
    .delete("/repos/:owner/:repo/:branch", deleteObjectsHandler)
    .post("/repos/:owner/:repo/branches", createEmptyBranchHandler)
    .post("/repos/:owner/:repo/branches/from", createBranchFromHandler)
    .use(handleError)

function rootHandler(req, res) {
    const path = (req.url || "").split("?")[0];
    if (req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
        return;
    }
    res.statusCode = 404;
    res.end("Not found");
}

exports.Main = new SimpleRouterBuilder()
    .withChildRouter("/github", githubRouter)
    .withRootHandler(rootHandler)
    .build();
