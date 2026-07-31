"use strict";

const { SimpleRouterBuilder, NewEmptyRouter } = require("simple-router-builder");

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

const githubRouter = NewEmptyRouter();

githubRouter.use(githubAuth);
githubRouter.post("/repos/:name", createRepoHandler);
githubRouter.post("/repos/:owner/:repo/upload", parseUpload, uploadObjectsHandler);
githubRouter.get("/repos/:owner/:repo/:branch", getBranchSnapshotHandler);
githubRouter.delete("/repos/:owner/:repo/:branch", deleteObjectsHandler);
githubRouter.post("/repos/:owner/:repo/branches", createEmptyBranchHandler);
githubRouter.post("/repos/:owner/:repo/branches/from", createBranchFromHandler);
githubRouter.use(handleError);

// Doubles as the health check: GET /healthz returns { status: "ok" };
// everything else unmatched (including unknown /github/* subpaths) 404s.
function rootHandler(req, res) {
    const path = (req.url || "").split("?")[0];

    if (req.method === "GET" && path === "/healthz") {
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
