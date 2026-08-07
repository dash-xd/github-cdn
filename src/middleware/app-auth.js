"use strict";

// Mirrors githubAuth's shape: a factory that takes a "give me an
// authenticated Octokit" closure and returns the actual middleware. Here
// there's no per-request token to read - the whole point of this router
// is that the function authenticates itself, as the app installation,
// rather than requiring the caller to bring a GitHub token.
function appAuth(getInstallationOctokit) {
    return function appAuthMiddleware(req, res, next) {
        res.locals.octokit = getInstallationOctokit();
        next();
    };
}

module.exports = { appAuth };
