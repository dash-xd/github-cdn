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
    <script id="api-reference" data-url="/docs/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;

function serveOpenApiDocument(req, res) {
    res.json(openApiDocument);
}

function serveDocsPage(req, res) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(DOCS_PAGE);
}

module.exports = { serveOpenApiDocument, serveDocsPage };
