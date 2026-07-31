"use strict";

const { NewEmptyRouter } = require("simple-router-builder");

const { githubAuth } = require("../middleware/github-auth.js");
const { parseUpload, objectPath } = require("../middleware/upload.js");
const {
    createRepo,
    commitFiles,
    getBranchSnapshot,
    deleteFiles,
    createEmptyBranch,
    createBranchFrom
} = require("../github/repo-service.js");

const router = NewEmptyRouter();

router.use(githubAuth);

// Create a repo named `<name>-<random>`.
router.post("/repos/:name", async (req, res, next) => {
    try {
        const repo = await createRepo(req.octokit, req.params.name, req.body || {});

        res.status(201).json({
            name: repo.name,
            owner: repo.owner.login,
            url: repo.html_url,
            default_branch: repo.default_branch
        });
    } catch (err) {
        next(err);
    }
});

// Upload one or more files (multipart/form-data) as content-addressed
// objects. Returns each object's id, storage path, and original
// filename/content-type as informational metadata.
router.post("/repos/:owner/:repo/upload", parseUpload, async (req, res, next) => {
    try {
        const branch = req.query.branch || req.body.branch;

        const result = await commitFiles(req.octokit, req.params.owner, req.params.repo, branch, req.files);

        res.json({
            repo: req.params.repo,
            branch: result.branch,
            commit: result.commit,
            objects: result.objects
        });
    } catch (err) {
        next(err);
    }
});

// Get a copy of a branch without cloning: file tree, optionally with content.
router.get("/repos/:owner/:repo/:branch", async (req, res, next) => {
    try {
        const includeContent = req.query.content === "true";

        const files = await getBranchSnapshot(
            req.octokit,
            req.params.owner,
            req.params.repo,
            req.params.branch,
            { includeContent }
        );

        res.json(files);
    } catch (err) {
        next(err);
    }
});

// Delete a file or list of files. Accepts raw tree paths ('path'/'paths')
// or content-addressed object ids ('objectId'/'objectIds') - object ids
// are resolved to their storage path the same way upload.js picks it.
router.delete("/repos/:owner/:repo/:branch", async (req, res, next) => {
    try {
        const explicitPaths = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path].filter(Boolean);

        const objectIds = Array.isArray(req.body.objectIds)
            ? req.body.objectIds
            : [req.body.objectId].filter(Boolean);

        const paths = [...explicitPaths, ...objectIds.map(objectPath)];

        if (paths.length === 0) {
            return res.status(400).json({
                error: "provide 'path'/'paths' or 'objectId'/'objectIds' in the request body"
            });
        }

        const result = await deleteFiles(req.octokit, req.params.owner, req.params.repo, req.params.branch, paths);

        res.json(result);
    } catch (err) {
        next(err);
    }
});

// Create a new empty branch (orphan commit, no history).
router.post("/repos/:owner/:repo/branches", async (req, res, next) => {
    try {
        if (!req.body.branch) {
            return res.status(400).json({ error: "'branch' is required" });
        }

        const result = await createEmptyBranch(req.octokit, req.params.owner, req.params.repo, req.body.branch);
        res.status(201).json(result);
    } catch (err) {
        next(err);
    }
});

// Create a new branch from an existing branch.
router.post("/repos/:owner/:repo/branches/from", async (req, res, next) => {
    try {
        if (!req.body.branch || !req.body.source) {
            return res.status(400).json({ error: "'branch' and 'source' are required" });
        }

        const result = await createBranchFrom(
            req.octokit,
            req.params.owner,
            req.params.repo,
            req.body.branch,
            req.body.source
        );

        res.status(201).json(result);
    } catch (err) {
        next(err);
    }
});

router.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ error: err.message || "internal error" });
});

module.exports = router;
