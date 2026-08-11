"use strict";

const openApiDocument = require("../../openapi.json");

const DOCS_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>github-cdn API Reference</title>
  </head>
  <body>
    <script id="api-reference"></script>
    <script>
      (function () {
        // The server can't always know its own public URL (see
        // src/middleware/docs.js and the README): on Cloud Functions
        // gen1, the function-name path segment is stripped before the
        // code ever sees req.url, so a server-rendered relative server
        // URL is a best-effort guess, not a guarantee. The browser has
        // no such blind spot - window.location is always the real,
        // complete URL this page was actually loaded at, no matter what
        // the server could see. So: fetch the spec, and if its server
        // URL is still relative (PUBLIC_BASE_URL wasn't set server-side),
        // replace it with one computed from this page's own location
        // before handing the spec to Scalar. This makes "Send Request"
        // work correctly with zero configuration, on any deployment
        // shape (gen1, gen2, local, behind a reverse proxy at any path
        // depth) - not just ones where an operator remembered to set an
        // env var.
        function isAbsolute(url) {
          return /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
        }

        function detectedBaseUrl() {
          var basePath = window.location.pathname.replace(/\/docs\/?$/, "");
          return window.location.origin + basePath;
        }

        function loadScalar() {
          var script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
          document.body.appendChild(script);
        }

        var el = document.getElementById("api-reference");

        fetch("docs/openapi.json")
          .then(function (res) { return res.json(); })
          .then(function (spec) {
            var server = spec.servers && spec.servers[0];
            if (!server || !isAbsolute(server.url)) {
              spec.servers = [{ url: detectedBaseUrl(), description: "Detected from this page's URL" }];
            }
            el.setAttribute("data-configuration", JSON.stringify({ spec: { content: spec } }));
          })
          .catch(function () {
            // Fetching/patching failed for some reason - fall back to
            // Scalar's own fetch of the (possibly still relative) spec,
            // rather than showing a blank page.
            el.setAttribute("data-url", "docs/openapi.json");
          })
          .then(loadScalar);
      })();
    </script>
  </body>
</html>
`;

// The relative server URL in openapi.json ("..", relative to wherever this
// document is fetched from) is correct per the OpenAPI spec, but not every
// client resolves it the same way a plain browser navigation would (see
// the inline script in DOCS_PAGE above for the client-side fix that
// actually matters here). This override is a secondary, optional escape
// hatch for deployments that want to force a specific value rather than
// rely on auto-detection - e.g. a fixed custom domain, or a reverse proxy
// setup where window.location doesn't match the true public origin.
function serveOpenApiDocument(req, res) {
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;

    const doc = publicBaseUrl
        ? { ...openApiDocument, servers: [{ url: publicBaseUrl, description: "Function root" }] }
        : openApiDocument;

    res.json(doc);
}

function serveDocsPage(req, res) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(DOCS_PAGE);
}

module.exports = { serveOpenApiDocument, serveDocsPage };
