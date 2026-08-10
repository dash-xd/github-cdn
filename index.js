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
const { createOrgRepoHandler } = require("./src/middleware/org-repos.js");
const { serveOpenApiDocument, serveDocsPage } = require("./src/middleware/docs.js");

const octokits = new Map();

function lazyCreateOctokit(token) {
    let octokit = octokits.get(token);
    if (!octokit) {
        octokit = createOctokit(token);
        octokits.set(token, octokit);
    }
    return octokit;
}

// Every route runs as whatever the caller's own token can do - personal
// or org, scoped however the token is scoped. There's no server-held
// GitHub credential anywhere in this deployment: the caller brings a
// token, it's forwarded straight through to Octokit, and that's the
// entire trust model - this function itself has nothing to authorize or
// protect beyond what GitHub already enforces for that token.
//
// createOrgRepoHandler sits alongside createRepoHandler for that same
// reason: org-owned repo creation isn't a separate privilege tier, it's
// just a different GitHub endpoint (POST /orgs/{org}/repos vs
// POST /user/repos) - any caller token with org repo-creation rights can
// use it exactly like any other route here.
const githubRouter = NewEmptyRouter()
    .use(githubAuth(lazyCreateOctokit))
    .post("/repos/:name", createRepoHandler)
    .post("/repos/:org/:name", createOrgRepoHandler)
    .post("/repos/:owner/:repo/upload", parseUpload, uploadObjectsHandler)
    .get("/repos/:owner/:repo/:branch", getBranchSnapshotHandler)
    .delete("/repos/:owner/:repo/:branch", deleteObjectsHandler)
    .post("/repos/:owner/:repo/branches", createEmptyBranchHandler)
    .post("/repos/:owner/:repo/branches/from", createBranchFromHandler)
    .use(handleError)

const docsRouter = NewEmptyRouter()
    .get("/", serveDocsPage)
    .get("/openapi.json", serveOpenApiDocument)

function rootHandler(req, res) {
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
    .withChildRouter("/docs", docsRouter)
    .withRootHandler(rootHandler)
    .build();
