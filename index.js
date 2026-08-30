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

// Keep caller GitHub credentials request-scoped. Authorization is deliberately
// not consumed here: on IAM-protected Cloud Run / Cloud Functions deployments,
// that header belongs to Google's ID-token authentication layer.
function createRequestOctokit(token) {
    return createOctokit(token);
}

// GitHub credentials always arrive independently in X-GH-Device-Access-Token.
// This keeps the application auth contract identical in both deployment modes:
//
//   public/locally reachable:  X-GH-Device-Access-Token only
//   Google IAM protected:      Authorization: Bearer <Google ID token>
//                              X-GH-Device-Access-Token: <GitHub token>
//
// Google IAM, when enabled, rejects the request before this function executes.
// The application therefore does not need to parse, validate, or switch on the
// Google bearer token; it only authenticates the caller to GitHub.
const githubRouter = NewEmptyRouter()
    .use(githubAuth(createRequestOctokit))
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

// `url` is included as a diagnostic: on Cloud Functions gen1, the
// function-name path segment (e.g. "github-cdn-router") never reaches
// req.url - Google's routing strips it before invoking this code. Hitting
// this endpoint on a real deployment and checking whether `url` includes
// that segment or not is the definitive way to confirm that for your own
// deployment, rather than taking it on faith.
function rootHandler(req, res) {
    if (req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok", url: req.url }));
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
