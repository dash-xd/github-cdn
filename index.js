"use strict";

const { SimpleRouterBuilder, NewEmptyRouter } = require("simple-router-builder");

const { createOctokit } = require("./src/lib/client.js");
const { createInstallationOctokit, createAppLevelOctokit } = require("./src/lib/app-client.js");
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

function requireAppCredentials() {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

    const missing = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"].filter((name) => !process.env[name]);
    if (missing.length > 0) {
        throw new Error(`missing required env var(s): ${missing.join(", ")}`);
    }

    return { appId, privateKey };
}

// App-level (JWT-only) Octokit, for looking up *which* installation
// covers a given org/repo - there's no fixed installation id configured
// anywhere, since this deployment isn't tied to just one. Built once and
// reused: like the installation Octokits below, @octokit/auth-app mints
// and refreshes the JWT internally.
let appLevelOctokit = null;

function getAppLevelOctokit() {
    if (!appLevelOctokit) {
        appLevelOctokit = createAppLevelOctokit(requireAppCredentials());
    }
    return appLevelOctokit;
}

// One Octokit per resolved installation id, not one global singleton:
// @octokit/auth-app caches and auto-refreshes the installation access
// token internally for whichever installation an Octokit instance was
// built for, so - same as the per-caller-token cache above - there's no
// need to rebuild it on every request, only once per *installation*
// this deployment has actually seen. This is what makes /app multi-
// tenant: an org or repo the App is installed on gets its own cached,
// self-refreshing client the first time it's touched, instead of the
// whole deployment being pinned to one installation chosen at deploy
// time.
const installationOctokits = new Map();

function installationOctokitFor(installationId) {
    let octokit = installationOctokits.get(installationId);
    if (!octokit) {
        octokit = createInstallationOctokit({ ...requireAppCredentials(), installationId });
        installationOctokits.set(installationId, octokit);
    }
    return octokit;
}

// org/repo -> installation id, cached for the life of the warm container
// (installations change rarely, and the failure mode if one is
// uninstalled mid-cache-lifetime is just a GitHub API error on the next
// call - not a security issue, since GitHub itself is still the one
// deciding whether that installation can do anything).
const installationIdByTarget = new Map();

// Resolves which installation covers a request's target and returns an
// Octokit authenticated as it. This is the actual authorization boundary
// for *what* an already-authorized /app caller (see requireAppAccess) can
// act on: GitHub's own API 404s here for any org/repo this App isn't
// installed on, so passing requireAppAccess only ever grants the ability
// to act as installations that genuinely exist - never an arbitrary org
// a caller names.
async function resolveInstallationOctokit(target) {
    const cacheKey = target.org ? `org:${target.org}` : `repo:${target.owner}/${target.repo}`;

    let installationId = installationIdByTarget.get(cacheKey);
    if (!installationId) {
        const octokit = getAppLevelOctokit();
        const { data } = target.org
            ? await octokit.rest.apps.getOrgInstallation({ org: target.org })
            : await octokit.rest.apps.getRepoInstallation({ owner: target.owner, repo: target.repo });
        installationId = data.id;
        installationIdByTarget.set(cacheKey, installationId);
    }

    return installationOctokitFor(installationId);
}

function forOrg(req) {
    return { org: req.params.org };
}

function forRepo(req) {
    return { owner: req.params.owner, repo: req.params.repo };
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

// Authenticates as a GitHub App installation itself (no caller-supplied
// GitHub token), so it needs its own gate in place of one: requireAppAccess
// authorizes the *call* via whichever strategy the deployment has
// configured - a trusted GCP caller identity (e.g. a WIF-authenticated
// GitHub Actions job, no shared secret required at all), a static shared
// secret (APP_ACCESS_SECRET), or both. See README "Calling this from
// automation" for why this is deliberately pluggable rather than one
// fixed mechanism.
//
// Passing that gate doesn't hand a caller the whole App, though: appAuth
// is applied per route (not as one router-wide .use(), since it needs
// req.params - see app-auth.js) and resolves the specific installation
// that covers whatever org/repo the request names, via forOrg/forRepo
// below. A caller can only ever act on orgs/repos this App is actually
// installed on - see resolveInstallationOctokit's comment above.
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
    .post("/repos/:org/:name", appAuth(forOrg, resolveInstallationOctokit), createOrgRepoHandler)
    .post("/repos/:owner/:repo/upload", appAuth(forRepo, resolveInstallationOctokit), parseUpload, uploadObjectsHandler)
    .get("/repos/:owner/:repo/:branch", appAuth(forRepo, resolveInstallationOctokit), getBranchSnapshotHandler)
    .delete("/repos/:owner/:repo/:branch", appAuth(forRepo, resolveInstallationOctokit), deleteObjectsHandler)
    .post("/repos/:owner/:repo/branches", appAuth(forRepo, resolveInstallationOctokit), createEmptyBranchHandler)
    .post("/repos/:owner/:repo/branches/from", appAuth(forRepo, resolveInstallationOctokit), createBranchFromHandler)
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
