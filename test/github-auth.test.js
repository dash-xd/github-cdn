"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    GITHUB_DEVICE_TOKEN_HEADER,
    githubAuth
} = require("../src/middleware/github-auth.js");

function response() {
    return {
        locals: {},
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

test("uses x-gh-device-access-token for GitHub and ignores Authorization bearer", () => {
    const seen = [];
    const middleware = githubAuth(token => {
        seen.push(token);
        return { token };
    });
    const req = {
        headers: {
            authorization: "Bearer google-iam-id-token",
            [GITHUB_DEVICE_TOKEN_HEADER]: "github-device-token"
        }
    };
    const res = response();
    let nextCalled = false;

    middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.deepEqual(seen, ["github-device-token"]);
    assert.deepEqual(res.locals.octokit, { token: "github-device-token" });
});

test("works without Authorization when only GitHub authentication is required", () => {
    const middleware = githubAuth(token => ({ token }));
    const req = {
        headers: {
            [GITHUB_DEVICE_TOKEN_HEADER]: "github-device-token"
        }
    };
    const res = response();
    let nextCalled = false;

    middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.deepEqual(res.locals.octokit, { token: "github-device-token" });
});

test("does not treat Authorization bearer as a GitHub token", () => {
    let createCalled = false;
    const middleware = githubAuth(() => {
        createCalled = true;
        return {};
    });
    const req = {
        headers: {
            authorization: "Bearer google-iam-id-token"
        }
    };
    const res = response();
    let nextCalled = false;

    middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(createCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
        error: "missing github token in x-gh-device-access-token"
    });
});
