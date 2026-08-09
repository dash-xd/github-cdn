"use strict";

// Mirrors githubAuth's shape: a factory that takes closures for the
// actual work and returns the middleware. Here there's no per-request
// GitHub token to read - the whole point of this router is that the
// function authenticates itself, as a GitHub App installation, rather
// than requiring the caller to bring a GitHub token. But *which*
// installation depends on what the request targets: the App may be
// installed on many orgs/accounts, and a single deployment should be
// able to act for any of them, not just one baked in at deploy time.
//
// - resolveTarget(req) -> { org } | { owner, repo }: reads whichever
//   path params identify what this route acts on. Kept separate from
//   resolveInstallationOctokit so the same resolution logic isn't
//   duplicated per route - index.js passes a small resolver per route
//   registration (forOrg / forRepo) since req.params is only populated
//   once a route's own path has matched.
// - resolveInstallationOctokit(target) -> Promise<Octokit>: looks up
//   which installation covers that target and returns an Octokit
//   authenticated as it (see index.js - this is also where per-
//   installation caching happens, so repeat calls for the same
//   org/repo don't re-resolve or rebuild anything).
function appAuth(resolveTarget, resolveInstallationOctokit) {
    return async function appAuthMiddleware(req, res, next) {
        try {
            res.locals.octokit = await resolveInstallationOctokit(resolveTarget(req));
            next();
        } catch (err) {
            next(err);
        }
    };
}

module.exports = { appAuth };
