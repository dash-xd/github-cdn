"use strict";

const crypto = require("node:crypto");

const { createAppLevelOctokit } = require("../lib/app-client.js");

const OAUTH_STATE_COOKIE = "oauth_state";
const STATE_TTL_SECONDS = 300;

// The app's slug (for the install link) is derivable from GITHUB_APP_ID/
// GITHUB_APP_PRIVATE_KEY, already required elsewhere, so it isn't a
// separate env var - fetched once via JWT auth and cached, same lazy-
// singleton shape as index.js's installationOctokit.
let cachedAppSlug = null;

async function getAppSlug() {
    if (cachedAppSlug) {
        return cachedAppSlug;
    }

    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

    if (!appId || !privateKey) {
        throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured to build the install link");
    }

    const octokit = createAppLevelOctokit({ appId, privateKey });
    const { data } = await octokit.rest.apps.getAuthenticated();
    cachedAppSlug = data.slug;
    return cachedAppSlug;
}

function parseCookies(header) {
    const cookies = {};

    (header || "").split(";").forEach((pair) => {
        const idx = pair.indexOf("=");
        if (idx === -1) return;
        cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });

    return cookies;
}

function buildPage({ authorizeUrl, installUrl }) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>github-cdn</title>
  </head>
  <body>
    <h1>github-cdn</h1>
    <p id="token-result"></p>
    <p><a href="${authorizeUrl}">Log in with GitHub</a></p>
    <p><a href="${installUrl}">Install the GitHub App</a></p>
    <script>
      (function () {
        var hash = window.location.hash.replace(/^#/, "");
        if (!hash) return;
        var params = new URLSearchParams(hash);
        var token = params.get("access_token");
        var error = params.get("error");
        var result = document.getElementById("token-result");
        if (token) {
          result.textContent = "Access token (copy now - shown once): " + token;
        } else if (error) {
          result.textContent = "Login failed: " + error;
        }
        history.replaceState(null, "", window.location.pathname);
      })();
    </script>
  </body>
</html>
`;
}

// GET /login - static page with a "log in" (OAuth user-to-server) link and
// an "install the app" link. The resulting access token is an ordinary
// GitHub token, used directly against /github - there's no separate
// authenticated-user API surface, since /github already accepts any
// caller-supplied token regardless of how the caller obtained it.
async function serveLoginPage(req, res, next) {
    try {
        const clientId = process.env.GITHUB_APP_CLIENT_ID;
        const publicBaseUrl = process.env.PUBLIC_BASE_URL;

        if (!clientId || !publicBaseUrl) {
            return res.status(500).json({
                error: "GITHUB_APP_CLIENT_ID and PUBLIC_BASE_URL must be configured"
            });
        }

        const appSlug = await getAppSlug();

        // CSRF protection for the OAuth flow: state is set in a short-lived
        // HttpOnly cookie here and compared against the callback's query
        // param there. SameSite=Lax (not Strict) is required, not just
        // permissible - Strict would drop the cookie on the top-level
        // navigation back from github.com, breaking the comparison.
        const state = crypto.randomBytes(16).toString("hex");

        res.setHeader(
            "Set-Cookie",
            `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}; Path=/login`
        );

        const authorizeUrl =
            `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
            `&redirect_uri=${encodeURIComponent(`${publicBaseUrl}/login/callback`)}` +
            `&state=${encodeURIComponent(state)}`;

        const installUrl = `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(buildPage({ authorizeUrl, installUrl }));
    } catch (err) {
        next(err);
    }
}

// GET /login/callback?code=...&state=...
// Exchanges the OAuth code for the user's own access token. This is the
// one step that has to be server-side: it needs GITHUB_APP_CLIENT_SECRET,
// which must never reach the browser. The resulting token is handed back
// in the redirect's URL fragment (never sent to any server or logged,
// unlike a query string) for /login's page script to read.
async function handleLoginCallback(req, res, next) {
    try {
        const publicBaseUrl = process.env.PUBLIC_BASE_URL;

        if (!publicBaseUrl) {
            return res.status(500).json({ error: "PUBLIC_BASE_URL is not configured" });
        }

        const { code, state, error } = req.query;

        res.setHeader("Set-Cookie", `${OAUTH_STATE_COOKIE}=; Max-Age=0; Path=/login`);

        if (error) {
            return res.redirect(`${publicBaseUrl}/login#error=${encodeURIComponent(error)}`);
        }

        const cookies = parseCookies(req.headers.cookie);
        const expectedState = cookies[OAUTH_STATE_COOKIE];

        if (!state || !expectedState || state !== expectedState) {
            return res.status(400).json({
                error: "missing or mismatched state - restart the login flow at /login"
            });
        }

        if (!code) {
            return res.status(400).json({ error: "missing 'code' query parameter" });
        }

        const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json"
            },
            body: JSON.stringify({
                client_id: process.env.GITHUB_APP_CLIENT_ID,
                client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
                code,
                redirect_uri: `${publicBaseUrl}/login/callback`
            })
        });

        const data = await tokenResponse.json();

        if (data.error) {
            return res.redirect(
                `${publicBaseUrl}/login#error=${encodeURIComponent(data.error_description || data.error)}`
            );
        }

        const fragment = new URLSearchParams({
            access_token: data.access_token,
            scope: data.scope || ""
        });

        res.redirect(`${publicBaseUrl}/login#${fragment.toString()}`);
    } catch (err) {
        next(err);
    }
}

module.exports = { serveLoginPage, handleLoginCallback };
