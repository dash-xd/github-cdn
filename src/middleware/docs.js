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
    <script id="api-reference" data-url="docs/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;

// The relative server URL in openapi.json ("..", relative to wherever this
// document is fetched from) is correct per the OpenAPI spec, but Scalar's
// "Send Request" testing feature resolves it against the *page* URL
// (/docs, no trailing slash) rather than the document's own fetch URL
// (/docs/openapi.json) - and on Cloud Functions gen1, where the function
// name is a required path segment this code never sees in req.url, that
// off-by-one-segment difference is enough to drop the function name
// entirely and send test requests to the bare origin, which 404s before
// ever reaching this code. Set PUBLIC_BASE_URL to this function's actual
// public URL (optional - nothing else on this branch needs it) to
// sidestep the ambiguity outright: an absolute server URL leaves nothing
// to resolve relative to anything.
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
