"use strict";

const { SimpleRouterBuilder, NewEmptyRouter } = require("simple-router-builder");

const { createOctokit } = require("./src/lib/client.js");
const { createInstallationOctokit } = require("./src/lib/app-client.js");
const { githubAuth } = require("./src/middleware/github-auth.js");
const { appAuth } = require("./src/middleware/app-auth.js");
const { requireAccessSecret } = require("./src/middleware/access-secret.js");
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
const { createOrgRepoHandler } = require("./src/middleware/app-repos.js");
const { serveManifestForm, handleManifestCallback, listInstallationsHandler } = require("./src/middleware/app-setup.js");
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

// A single installation Octokit, built once and reused: @octokit/auth-app
// caches and refreshes the installation access token internally, so
// there's no need to rebuild this per request the way lazyCreateOctokit
// does for per-caller PATs above.
let installationOctokit = null;

function getInstallationOctokit() {
    if (!installationOctokit) {
        const appId = process.env.GITHUB_APP_ID;
        const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
        const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

        const missing = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"].filter(
            (name) => !process.env[name]
        );

        if (missing.length > 0) {
            throw new Error(`missing required env var(s): ${missing.join(", ")}`);
        }

        installationOctokit = createInstallationOctokit({ appId, privateKey, installationId });
    }

    return installationOctokit;
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

// Authenticates as the app installation itself (no caller-supplied GitHub
// token), so it needs its own gate in place of one: requireAccessSecret
// checks a server-configured shared secret instead. Everything except
// repo creation reuses the exact same handlers as githubRouter above -
// they only ever touch res.locals.octokit, so they don't care whether it
// was built from a caller's PAT or an installation token. Repo creation
// doesn't reuse createRepoHandler: installation tokens can't call
// POST /user/repos, so org-owned creation needs its own :org-scoped route.
const appRouter = NewEmptyRouter()
    .use(requireAccessSecret(() => process.env.APP_ROUTER_SECRET))
    .use(appAuth(getInstallationOctokit))
    .post("/repos/:org/:name", createOrgRepoHandler)
    .post("/repos/:owner/:repo/upload", parseUpload, uploadObjectsHandler)
    .get("/repos/:owner/:repo/:branch", getBranchSnapshotHandler)
    .delete("/repos/:owner/:repo/:branch", deleteObjectsHandler)
    .post("/repos/:owner/:repo/branches", createEmptyBranchHandler)
    .post("/repos/:owner/:repo/branches/from", createBranchFromHandler)
    .use(handleError)

// Bootstraps a GitHub App for an org when one doesn't exist yet, via
// GitHub's manifest flow. Unauthenticated by design - see README for why,
// and for the operational precautions this needs (this is a one-time
// admin action, not meant to be a public-facing feature).
const setupRouter = NewEmptyRouter()
    .get("/", serveManifestForm)
    .get("/callback", handleManifestCallback)
    .get("/installations", listInstallationsHandler)

const docsRouter = NewEmptyRouter()
    .get("/", serveDocsPage)
    .get("/openapi.json", serveOpenApiDocument)

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
    .withChildRouter("/app", appRouter)
    .withChildRouter("/setup", setupRouter)
    .withChildRouter("/docs", docsRouter)
    .withRootHandler(rootHandler)
    .build();
