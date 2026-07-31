"use strict";

const { createOctokit } = require("../lib/client.js");

function githubAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

    if (!token) {
        return res.status(401).json({ error: "missing github token" });
    }

    req.octokit = createOctokit(token);
    next();
}

module.exports = { githubAuth };
