"use strict";

const { createOrgRepo } = require("../lib/repo-service.js");

// Create a repo named `<name>-<random>` inside an org. Separate from
// createRepoHandler (src/middleware/github-repos.js) because repo
// ownership is the one thing that isn't implicit in a caller's token the
// way it is for every other route: a personal access token creates under
// the token owner's account (POST /user/repos), but an org-owned repo
// needs POST /orgs/{org}/repos (repos.createInOrg) with the org named
// explicitly. Installation tokens have no "authenticated user" at all, so
// for /app this is the *only* way to create a repo - but it works just as
// well for /github, for any caller whose own token has org repo-creation
// rights. Shared by both routers; only the auth in front of it differs.
async function createOrgRepoHandler(req, res, next) {
    try {
        const repo = await createOrgRepo(res.locals.octokit, req.params.org, req.params.name, req.body || {});

        res.status(201).json({
            name: repo.name,
            owner: repo.owner.login,
            url: repo.html_url,
            default_branch: repo.default_branch
        });
    } catch (err) {
        next(err);
    }
}

module.exports = { createOrgRepoHandler };
