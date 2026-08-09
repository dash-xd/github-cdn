"use strict";

const { Octokit } = require("@octokit/rest");

const { createAppLevelOctokit } = require("../lib/app-client.js");

function buildManifest({ appName, publicBaseUrl }) {
    return {
        name: appName,
        url: publicBaseUrl,
        redirect_url: `${publicBaseUrl}/setup/callback`,
        public: false,
        default_permissions: {
            contents: "write",
            metadata: "read",
            organization_administration: "write"
        },
        default_events: []
    };
}

// GET /setup?org=<org-login>
// Renders a page that auto-submits GitHub's app-manifest form, which is
// how GitHub Apps get created programmatically: the manifest itself is
// too large to pass as a query string, so it has to be POSTed by an HTML
// form. See https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
function serveManifestForm(req, res) {
    const org = req.query.org;
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;

    if (!org) {
        return res.status(400).json({ error: "provide '?org=<org-login>'" });
    }

    if (!publicBaseUrl) {
        return res.status(500).json({
            error: "PUBLIC_BASE_URL is not configured - required to build the manifest's redirect_url correctly"
        });
    }

    const manifest = buildManifest({ appName: `${org}-github-cdn`, publicBaseUrl });
    const targetUrl = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`;
    const manifestJson = JSON.stringify(manifest).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Create GitHub App for ${org}</title>
  </head>
  <body>
    <form id="manifest-form" action="${targetUrl}" method="post">
      <input type="hidden" name="manifest" value="${manifestJson}" />
      <noscript><button type="submit">Create GitHub App for ${org}</button></noscript>
    </form>
    <script>document.getElementById("manifest-form").submit();</script>
  </body>
</html>
`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
}

// GET /setup/callback?code=...
// GitHub redirects here once the operator confirms app creation. The code
// is single-use and short-lived; exchanging it for the app's credentials
// needs no auth of its own (the code is the credential). This response is
// the only place those credentials are ever surfaced - copy them into
// GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY and redeploy, then install the
// app on whichever orgs/accounts should be able to use /app.
// GET /setup/installations lists them, informationally - /app itself
// resolves the right installation per request, no installation id needs
// to be configured anywhere (see index.js's resolveInstallationOctokit).
async function handleManifestCallback(req, res, next) {
    try {
        const code = req.query.code;

        if (!code) {
            return res.status(400).json({ error: "missing 'code' query parameter" });
        }

        const octokit = new Octokit();
        const { data } = await octokit.rest.apps.createFromManifest({ code });

        res.json({
            id: data.id,
            slug: data.slug,
            client_id: data.client_id,
            client_secret: data.client_secret,
            webhook_secret: data.webhook_secret,
            pem: data.pem,
            html_url: data.html_url,
            note: "One-time only - this is not stored anywhere. Set GITHUB_APP_ID=id and GITHUB_APP_PRIVATE_KEY=pem, then install the app on whichever orgs/accounts should be able to use /app. No installation id needs to be configured - /app resolves the right one per request. GET /setup/installations lists current installations."
        });
    } catch (err) {
        next(err);
    }
}

// GET /setup/installations
// Lists this app's current installations (app-level JWT auth only - no
// installation id needed). Purely informational - useful for confirming
// an install worked or auditing where the app has access - since /app
// resolves the installation for a given request itself and doesn't read
// this list or need any installation id configured.
async function listInstallationsHandler(req, res, next) {
    try {
        const appId = process.env.GITHUB_APP_ID;
        const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

        if (!appId || !privateKey) {
            return res.status(400).json({
                error: "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured before installations can be listed"
            });
        }

        const octokit = createAppLevelOctokit({ appId, privateKey });
        const { data } = await octokit.rest.apps.listInstallations();

        res.json(
            data.map((installation) => ({
                installationId: installation.id,
                account: installation.account && installation.account.login,
                targetType: installation.target_type
            }))
        );
    } catch (err) {
        next(err);
    }
}

module.exports = { serveManifestForm, handleManifestCallback, listInstallationsHandler };
