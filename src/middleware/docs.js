"use strict";

const openApiDocument = require("../../openapi.json");

const DOCS_PAGE = String.raw`<!doctype html>
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
            el.setAttribute("data-url", "docs/openapi.json");
          })
          .then(loadScalar);
      })();
    </script>
  </body>
</html>
`;

function runtimeOpenApiDocument(publicBaseUrl) {
    const components = openApiDocument.components || {};
    const securitySchemes = components.securitySchemes || {};
    const responses = components.responses || {};

    return {
        ...openApiDocument,
        ...(publicBaseUrl
            ? { servers: [{ url: publicBaseUrl, description: "Function root" }] }
            : {}),
        components: {
            ...components,
            securitySchemes: {
                ...securitySchemes,
                githubToken: {
                    type: "apiKey",
                    in: "header",
                    name: "X-GH-Device-Access-Token",
                    description:
                        "Caller-supplied GitHub access token. Authorization is reserved for optional Google IAM invocation authentication."
                }
            },
            responses: {
                ...responses,
                Unauthorized: {
                    ...(responses.Unauthorized || {}),
                    description: "Missing X-GH-Device-Access-Token header."
                }
            }
        }
    };
}

function serveOpenApiDocument(req, res) {
    const doc = runtimeOpenApiDocument(process.env.PUBLIC_BASE_URL);

    res.setHeader("Cache-Control", "no-store");
    res.json(doc);
}

function serveDocsPage(req, res) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(DOCS_PAGE);
}

module.exports = { runtimeOpenApiDocument, serveOpenApiDocument, serveDocsPage };
