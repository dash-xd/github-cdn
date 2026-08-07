"use strict";

const { createOrgRepo } = require("../lib/repo-service.js");

// Create a repo named `<name>-<random>` inside an org. Separate from
// createRepoHandler (src/middleware/github-repos.js) because installation
// tokens can't call POST /user/repos - GitHub Apps have no "authenticated
// user" the way a personal access token does, so org-owned creation has
// to go through POST /orgs/{org}/repos (repos.createInOrg) instead, which
// needs the org in the route.
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
