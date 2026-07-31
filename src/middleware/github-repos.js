"use strict";

const { objectPath } = require("./upload.js");
const {
    createRepo,
    commitFiles,
    getBranchSnapshot,
    deleteFiles,
    createEmptyBranch,
    createBranchFrom
} = require("../lib/repo-service.js");

// Create a repo named `<name>-<random>`.
async function createRepoHandler(req, res, next) {
    try {
        const repo = await createRepo(res.locals.octokit, req.params.name, req.body || {});

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

// Upload one or more files (multipart/form-data) as content-addressed
// objects. Returns each object's id, storage path, and original
// filename/content-type as informational metadata. Run parseUpload first.
async function uploadObjectsHandler(req, res, next) {
    try {
        const branch = req.query.branch || req.body.branch;

        const result = await commitFiles(res.locals.octokit, req.params.owner, req.params.repo, branch, res.locals.files);

        res.json({
            repo: req.params.repo,
            branch: result.branch,
            commit: result.commit,
            objects: result.objects
        });
    } catch (err) {
        next(err);
    }
}

// Get a copy of a branch without cloning: file tree, optionally with content.
async function getBranchSnapshotHandler(req, res, next) {
    try {
        const includeContent = req.query.content === "true";

        const files = await getBranchSnapshot(
            res.locals.octokit,
            req.params.owner,
            req.params.repo,
            req.params.branch,
            { includeContent }
        );

        res.json(files);
    } catch (err) {
        next(err);
    }
}

// Delete a file or list of files. Accepts raw tree paths ('path'/'paths')
// or content-addressed object ids ('objectId'/'objectIds') - object ids
// are resolved to their storage path the same way upload.js picks it.
async function deleteObjectsHandler(req, res, next) {
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

        const result = await deleteFiles(res.locals.octokit, req.params.owner, req.params.repo, req.params.branch, paths);

        res.json(result);
    } catch (err) {
        next(err);
    }
}

// Create a new empty branch (orphan commit, no history).
async function createEmptyBranchHandler(req, res, next) {
    try {
        if (!req.body.branch) {
            return res.status(400).json({ error: "'branch' is required" });
        }

        const result = await createEmptyBranch(res.locals.octokit, req.params.owner, req.params.repo, req.body.branch);
        res.status(201).json(result);
    } catch (err) {
        next(err);
    }
}

// Create a new branch from an existing branch.
async function createBranchFromHandler(req, res, next) {
    try {
        if (!req.body.branch || !req.body.source) {
            return res.status(400).json({ error: "'branch' and 'source' are required" });
        }

        const result = await createBranchFrom(
            res.locals.octokit,
            req.params.owner,
            req.params.repo,
            req.body.branch,
            req.body.source
        );

        res.status(201).json(result);
    } catch (err) {
        next(err);
    }
}

// Error-handling middleware (4-arg) for the github router.
function handleError(err, req, res, next) {
    const status = Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ error: err.message || "internal error" });
}

module.exports = {
    createRepoHandler,
    uploadObjectsHandler,
    getBranchSnapshotHandler,
    deleteObjectsHandler,
    createEmptyBranchHandler,
    createBranchFromHandler,
    handleError
};
