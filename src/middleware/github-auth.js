"use strict";

const GITHUB_DEVICE_TOKEN_HEADER = "x-gh-device-access-token";

function githubAuth(createOctokit) {
    return function githubAuthMiddleware(req, res, next) {
        const token = String(req.headers[GITHUB_DEVICE_TOKEN_HEADER] || "").trim();

        if (!token) {
            return res.status(401).json({
                error: `missing github token in ${GITHUB_DEVICE_TOKEN_HEADER}`
            });
        }

        res.locals.octokit = createOctokit(token);
        next();
    };
}

module.exports = { GITHUB_DEVICE_TOKEN_HEADER, githubAuth };
