"use strict";

const { SimpleRouterBuilder, NewEmptyRouter } = require("simple-router-builder");

const { createOctokit } = require("./src/lib/client.js");
const { createInstallationOctokit } = require("./src/lib/app-client.js");
const { githubAuth } = require("./src/middleware/github-auth.js");
const { appAuth } = require("./src/middleware/app-auth.js");
const { requireAppAccess } = require("./src/middleware/app-access.js");
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
const { serveManifestForm, handleManifestCallback, listInstallationsHandler } = require("./src/middleware/app-setup.js");
const { serveLoginPage, handleLoginCallback } = require("./src/middleware/oauth-login.js");
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

function trustedGcpInvokerEmails() {
    return (process.env.TRUSTED_GCP_INVOKER_EMAILS || "")
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean);
}

// Every route here runs as whatever the caller's own token can do -
// personal or org, scoped however the token is scoped. createOrgRepoHandler
// is included alongside createRepoHandler for that reason: org-owned repo
// creation isn't an "/app-only" capability, it's just a different GitHub
// endpoint (POST /orgs/{org}/repos vs POST /user/repos) that any adequately-
// scoped caller token can use too.
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

// Authenticates as the app installation itself (no caller-supplied GitHub
// token), so it needs its own gate in place of one: requireAppAccess
// authorizes the *call* via whichever strategy the deployment has
// configured - a trusted GCP caller identity (e.g. a WIF-authenticated
// GitHub Actions job, no shared secret required at all), a static shared
// secret (APP_ACCESS_SECRET), or both. See README "Calling this from
// automation" and requireAppAccess's own comments in app-access.js for
// why this is deliberately pluggable rather than one fixed mechanism.
//
// Every route here reuses the exact same handlers as githubRouter above -
// they only ever touch res.locals.octokit, so they don't care whether it
// was built from a caller's PAT or an installation token.
//
// This is for no-human-present server automation (CI, cron, etc) that
// doesn't want to manage its own GitHub credentials at all. It's not the
// only automation path, though: a caller that already has its own PAT or
// installation token (e.g. minted via a separate step in the same
// workflow) can just call githubRouter above directly with it.
const appRouter = NewEmptyRouter()
    .use(
        requireAppAccess({
            getSecret: () => process.env.APP_ACCESS_SECRET,
            getTrustedEmails: trustedGcpInvokerEmails,
            getAudience: () => process.env.APP_IDENTITY_AUDIENCE || process.env.PUBLIC_BASE_URL
        })
    )
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

// Self-serve alternative to /app: a user logs in with their own GitHub
// account (OAuth user-to-server) and gets back an ordinary GitHub token,
// which they then use directly against /github - no new protected repo
// API needed here, just the login page and the one step that has to be
// server-side (the code-for-token exchange, which needs the client secret).
const loginRouter = NewEmptyRouter()
    .get("/", serveLoginPage)
    .get("/callback", handleLoginCallback)
    .use(handleError)

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
    .withChildRouter("/login", loginRouter)
    .withChildRouter("/docs", docsRouter)
    .withRootHandler(rootHandler)
    .build();
