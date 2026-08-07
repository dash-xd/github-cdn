"use strict";

const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");

// Env vars commonly can't hold literal newlines, so PEM keys are often
// passed with "\n" escape sequences instead of real ones. Undo that.
function normalizePrivateKey(privateKey) {
    if (!privateKey) return privateKey;
    return privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
}

// An Octokit instance authenticated as one specific installation of a
// GitHub App. @octokit/auth-app handles minting/refreshing the JWT and
// installation access token internally, so this instance is meant to be
// created once and reused across requests, not rebuilt per-call.
function createInstallationOctokit({ appId, privateKey, installationId }) {
    return new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId,
            privateKey: normalizePrivateKey(privateKey),
            installationId
        }
    });
}

// An Octokit instance authenticated at the app level (JWT only, no
// installation). Used before an installation id is known yet, e.g. to
// list installations during setup.
function createAppLevelOctokit({ appId, privateKey }) {
    return new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId,
            privateKey: normalizePrivateKey(privateKey)
        }
    });
}

module.exports = { createInstallationOctokit, createAppLevelOctokit, normalizePrivateKey };
