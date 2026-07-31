"use strict";

const { Octokit } = require("@octokit/rest");

function createOctokit(token) {
    return new Octokit({ auth: token });
}

module.exports = { createOctokit };
