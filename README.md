# github-cdn

Treats GitHub as a content store: an HTTP Cloud Function that creates repos,
uploads files, snapshots branches, deletes files, and manages branches
through the GitHub Git Data API via Octokit — no local `git clone` involved.

## Layout

```
index.js                       Cloud Function entry point: builds the router and exports Main
openapi.json                   OpenAPI 3.2.0 document describing every route
src/
  lib/
    client.js                  createOctokit(token) -> Octokit instance
    repo-service.js            GitHub Git Data API service layer (createRepo, commitFiles, getBranchSnapshot, deleteFiles, createEmptyBranch, createBranchFrom)
  middleware/
    github-auth.js             githubAuth(createOctokit): returns a middleware that builds res.locals.octokit from the request's Bearer token
    upload.js                  parseUpload: busboy multipart parser + SHA-256 content addressing; writes res.locals.files, plus objectPath()
    github-repos.js            one middleware function per route (createRepoHandler, uploadObjectsHandler, ...) plus handleError
    docs.js                    serveDocsPage / serveOpenApiDocument for /docs
```

There's no `routes/` directory: index.js imports the middleware functions
above and wires up the router itself, rather than importing a pre-built
router module.

`index.js`, in full:

```js
const { SimpleRouterBuilder, NewEmptyRouter } = require("simple-router-builder");

const { createOctokit } = require("./src/lib/client.js");
const { githubAuth } = require("./src/middleware/github-auth.js");
const { parseUpload } = require("./src/middleware/upload.js");
const {
    createRepoHandler,
    uploadObjectsHandler,
    getBranchSnapshotHandler,
    deleteObjectsHandler,
    createEmptyBranchHandler,
    createBranchFromHandler,
    handleError
} = require("./src/middleware/github-repos.js");
const { serveOpenApiDocument, serveDocsPage } = require("./src/middleware/docs.js");

// One Octokit instance per token, reused for the lifetime of this warm
// function instance instead of being rebuilt on every request.
const octokits = new Map();

function lazyCreateOctokit(token) {
    let octokit = octokits.get(token);
    if (!octokit) {
        octokit = createOctokit(token);
        octokits.set(token, octokit);
    }
    return octokit;
}

const githubRouter = NewEmptyRouter()
    .use(githubAuth(lazyCreateOctokit))
    .post("/repos/:name", createRepoHandler)
    .post("/repos/:owner/:repo/upload", parseUpload, uploadObjectsHandler)
    .get("/repos/:owner/:repo/:branch", getBranchSnapshotHandler)
    .delete("/repos/:owner/:repo/:branch", deleteObjectsHandler)
    .post("/repos/:owner/:repo/branches", createEmptyBranchHandler)
    .post("/repos/:owner/:repo/branches/from", createBranchFromHandler)
    .use(handleError);

const docsRouter = NewEmptyRouter()
    .get("/", serveDocsPage)
    .get("/openapi.json", serveOpenApiDocument);

function rootHandler(req, res) {
    // GET /healthz -> { status: "ok" }; everything else unmatched -> 404
}

exports.Main = new SimpleRouterBuilder()
    .withChildRouter("/github", githubRouter)
    .withChildRouter("/docs", docsRouter)
    .withRootHandler(rootHandler)
    .build();
```

`githubRouter` and `docsRouter` are built with `NewEmptyRouter()` from
`simple-router-builder` — a thin wrapper around the standalone `router`
package (the same routing engine Express's own `Router` is built on), not
`express.Router()`. This project has no direct dependency on `express` at
all.

That still works with `res.json`/`res.status`/`res.locals`/`req.query`/`req.body`
because `@google-cloud/functions-framework` (run via `npx`, see below)
wraps everything in its own Express app *before* calling `Main` — it parses
the request body itself (json/urlencoded/raw/text, by content-type) and
attaches the full Express `req`/`res` prototype ahead of time. So by the
time a request reaches a router, `req.body` is already populated, `res.locals`
is already an object, and `res.json` already exists — the routers just need
to route.

`githubAuth` is a factory rather than a middleware itself:
`githubAuth(createOctokit)` returns the actual `(req, res, next)`
middleware, so `src/middleware/github-auth.js` never needs to `require`
`src/lib/client.js` — whatever `createOctokit`-shaped function it's handed
is what gets called with the request's Bearer token. `index.js` is the only
place that requires `src/lib/client.js` directly, and it injects
`lazyCreateOctokit` instead of the raw `createOctokit`: a thin cache keyed
by token in a module-scope `Map`, so a warm function instance reuses the
same `Octokit` client across requests instead of constructing a new one
every time.

Data a middleware computes for downstream handlers — the Octokit client,
the parsed upload files — lives on `res.locals` (`res.locals.octokit`,
`res.locals.files`), not on `req`. `req` stays limited to what the request
itself actually carries (`req.params`, `req.query`, `req.body`).

Auth is per-request and stateless: each call must send `Authorization: Bearer <github token>`.
No token is stored on the server past the lifetime of the warm function instance.
`GET /docs` and `GET /docs/openapi.json` don't require auth.

## API reference

`GET /docs` serves an interactive API reference generated from
`openapi.json`, rendered with [Scalar](https://github.com/scalar/scalar) —
the whole page is one `<script id="api-reference" data-url="/docs/openapi.json">`
tag plus Scalar's CDN loader script, no build step or npm dependency.
Scalar was chosen over Swagger UI because it renders OpenAPI 3.1/3.2
documents natively; Swagger UI's 3.2 support landed later and is less
complete as of this writing. `GET /docs/openapi.json` serves the raw
document (`openapi.json` at the repo root) for any other tool that wants
to consume it directly (Postman, Insomnia, codegen, etc.).

The spec documents every route below, including request/response schemas,
the bearer-token security scheme, and worked examples for the upload and
delete bodies.

## Health check

There's no dedicated health router — `GET /healthz` is answered directly by
the `SimpleRouterBuilder` root handler in `index.js` with `{ "status": "ok" }`.
Any other request that doesn't match `/github/...`, `/docs`, or `/healthz`
gets a plain 404 from that same root handler.

## Object model

Uploads are content-addressed, not path-addressed:

```
upload -> raw content -> SHA-256 -> immutable object -> Git-backed object store
```

`parseUpload` (`src/middleware/upload.js`) hashes each uploaded file's bytes
and stores it at `objects/<hash prefix>/<hash>` via `commitFiles`
(`src/lib/repo-service.js`). The upload path doesn't know or care whether
the object will later be read back as a secret, a config file, a build
artifact, or a plain user upload — storage identity comes from content, not
from the caller-supplied filename. `originalName` and `contentType` are
carried along as informational metadata only; they never affect where the
object is written. One consequence: re-uploading identical bytes is
idempotent (same hash, same path, no path-traversal surface to sanitize),
and uploading the same content twice in one request only writes one blob.

This mirrors Git's own split between objects (immutable content) and refs
(human/application meaning) — layering something like `refs/secrets/prod.json
-> { "productionDatabase": "<objectId>" }` on top, with its own
authorization/decryption rules, is a read-side concern for later and isn't
part of this router.

## Run

The Cloud Functions runtime is not installed as a dependency; it's fetched on demand via `npx`.

```
npm install
npm run dev   # npx @google-cloud/functions-framework --target=Main --port=8080
```

Then open `http://localhost:8080/docs` for the API reference.

## Routes (mounted under `/github`)

| Method | Path | Body / Query | Description |
| --- | --- | --- | --- |
| POST | `/repos/:name` | `{ private?: boolean }` | Create a repo named `<name>-<random8>` |
| POST | `/repos/:owner/:repo/upload` | multipart form: one or more files, optional `branch` field | Store uploaded files as content-addressed objects, returns each object's id/path/metadata |
| GET | `/repos/:owner/:repo/:branch` | `?content=true` to include base64 file content | Snapshot a branch's file tree without cloning |
| DELETE | `/repos/:owner/:repo/:branch` | `{ paths: string[] }` or `{ objectIds: string[] }` (singular `path`/`objectId` also accepted) | Delete one or more objects in a single commit, by tree path or by object id |
| POST | `/repos/:owner/:repo/branches` | `{ branch: string }` | Create a new empty (orphan) branch |
| POST | `/repos/:owner/:repo/branches/from` | `{ branch: string, source: string }` | Create a new branch from an existing branch |

### Examples

```
POST /github/repos/my-app
Authorization: Bearer ghp_xxx
-> { "name": "my-app-a82f91cd", "owner": "...", "url": "...", "default_branch": "main" }

curl -H "Authorization: Bearer TOKEN" \
     -F "file=@example.tar.gz" -F "branch=main" \
     localhost:8080/github/repos/user/my-app-a82f91cd/upload
-> {
     "repo": "my-app-a82f91cd",
     "branch": "main",
     "commit": "...",
     "objects": [
       {
         "objectId": "a3f5c9d8e9f0...",
         "path": "objects/a3/a3f5c9d8e9f0...",
         "name": "example.tar.gz",
         "contentType": "application/gzip",
         "size": 1048576
       }
     ]
   }

GET /github/repos/user/my-app-a82f91cd/main?content=true

DELETE /github/repos/user/my-app-a82f91cd/main
{ "objectIds": ["a3f5c9d8e9f0..."] }

POST /github/repos/user/my-app-a82f91cd/branches
{ "branch": "empty-branch" }

POST /github/repos/user/my-app-a82f91cd/branches/from
{ "branch": "feature", "source": "main" }
```

## Notes

- `simple-router-builder` isn't published to the npm registry, so `package.json`
  pulls it directly from source: `"simple-router-builder": "github:dash-xd/simple-router-builder#main"`.
  `npm install` needs read access to that repo.
- Routing uses `simple-router-builder`'s `NewEmptyRouter()` end to end — this
  project doesn't depend on `express` at all. `req.body`/`req.query`/`res.json`/`res.locals`
  still work because `@google-cloud/functions-framework` supplies them via its
  own internal Express app before `Main` is ever invoked.
- Octokit clients are cached per Bearer token in a module-scope `Map`
  (`octokits` in `index.js`), so a warm invocation reuses the same client
  instead of constructing a new one on every request. The cache lives only
  as long as the warm container does.
- `@octokit/rest` is pinned to `^20` because `^21` and later are ESM-only and this project uses CommonJS (`require`), matching the Cloud Functions entry point convention.
- `openapi.json` uses a couple of genuine OpenAPI 3.2.0 additions where they
  fit naturally: the top-level `$self` field for document identity, and the
  new `Tag.summary` field. It doesn't reach for 3.2 features that don't
  apply to this API's shape (streaming media types, `additionalOperations`
  for non-standard verbs).
