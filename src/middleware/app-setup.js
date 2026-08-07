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
// GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY and redeploy, then use
// GET /setup/installations to find GITHUB_APP_INSTALLATION_ID.
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
            note: "One-time only - this is not stored anywhere. Set GITHUB_APP_ID=id, GITHUB_APP_PRIVATE_KEY=pem, install the app on your org if you haven't yet, then call GET /setup/installations to find GITHUB_APP_INSTALLATION_ID."
        });
    } catch (err) {
        next(err);
    }
}

// GET /setup/installations
// Lists installations of this app (app-level JWT auth only - no
// installation id needed yet), so the operator can read off the right
// GITHUB_APP_INSTALLATION_ID once GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY
// are set.
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
