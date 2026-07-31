"use strict";

const express = require("express");

const { githubAuth } = require("../middleware/github-auth.js");
const { parseUpload } = require("../middleware/upload.js");
const {
    createRepo,
    commitFiles,
    getBranchSnapshot,
    deleteFiles,
    createEmptyBranch,
    createBranchFrom
} = require("../github/repo-service.js");

const router = express.Router();

router.use(express.json());
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

// Upload one or more files (multipart/form-data), returns the repo name.
router.post("/repos/:owner/:repo/upload", parseUpload, async (req, res, next) => {
    try {
        const branch = req.query.branch || req.body.branch;

        const result = await commitFiles(req.octokit, req.params.owner, req.params.repo, branch, req.files);

        res.json({ repo: req.params.repo, branch: result.branch, commit: result.commit });
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

// Delete a file or list of files given path(s).
router.delete("/repos/:owner/:repo/:branch", async (req, res, next) => {
    try {
        const paths = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path].filter(Boolean);

        if (paths.length === 0) {
            return res.status(400).json({ error: "provide 'path' or 'paths' in the request body" });
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
