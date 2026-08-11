# github-cdn

Treats GitHub as a content store: an HTTP Cloud Function that creates repos,
uploads files, snapshots branches, deletes files, and manages branches
through the GitHub Git Data API via Octokit — no local `git clone` involved.

This branch is the stateless, token-only version: the caller always brings
their own GitHub token and whatever repo/org data the request needs. There
is no GitHub App, no installation auth, no server-held credential, and no
shared secret of any kind - this function holds nothing on your behalf. If
you're looking for GitHub App-based automation (no caller token, the
function acts as an installed App on the caller's behalf), that's a
different branch; it doesn't exist here by design.

## Layout

```
index.js                       Cloud Function entry point: builds the router and exports Main
openapi.json                   OpenAPI 3.2.0 document describing every route
src/
  lib/
    client.js                  createOctokit(token) -> Octokit instance
    repo-service.js            GitHub Git Data API service layer (createRepo, createOrgRepo, commitFiles, getBranchSnapshot, deleteFiles, createEmptyBranch, createBranchFrom)
  middleware/
    github-auth.js             githubAuth(createOctokit): returns a middleware that builds res.locals.octokit from the request's Bearer token
    upload.js                  parseUpload: busboy multipart parser + SHA-256 content addressing; writes res.locals.files, plus objectPath()
    github-repos.js            one middleware function per route (createRepoHandler, uploadObjectsHandler, ...) plus handleError
    org-repos.js                createOrgRepoHandler: org-scoped repo creation
    docs.js                    serveDocsPage / serveOpenApiDocument for /docs
```

There's no `routes/` directory: index.js imports the middleware functions
above and wires up the router itself, rather than importing a pre-built
router module.

## Authentication

One way, no exceptions: the caller supplies their own GitHub token as
`Authorization: Bearer <token>`, and it's forwarded straight through to
Octokit. Whoever holds the token is authorized for whatever that token can
do - personal or org, including org-owned repo creation, if the token is
scoped for it. This function never stores, generates, or checks anything
of its own; there is nothing to configure to make it "work" beyond
deploying it. If a request's token doesn't have the rights GitHub requires
for what it's asking to do, GitHub's own API rejects it - this service
adds no authorization logic on top of that.

`githubAuth` (`src/middleware/github-auth.js`) is a factory rather than
middleware itself: it takes a "give me an authenticated Octokit" closure
and returns the actual `(req, res, next)` middleware. It doesn't require
`src/lib/client.js` directly - `index.js` is the only place that does, and
it's what injects `lazyCreateOctokit` (a per-token cache, so the same
caller's Octokit instance is reused across requests rather than rebuilt
each time - see `octokits` in `index.js`).

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

Then open `http://localhost:8080/docs` for the API reference. No env vars
are required to run this at all - every route needs only the caller's own
token, supplied per request. The one optional exception is `PUBLIC_BASE_URL`
- see "API reference" below for what it's for.

## Routes (mounted under `/github`)

| Method | Path | Body / Query | Description |
| --- | --- | --- | --- |
| POST | `/repos/:name` | `{ private?: boolean }` | Create a repo named `<name>-<random8>` under the caller's own account |
| POST | `/repos/:org/:name` | `{ private?: boolean }` | Create a repo named `<name>-<random8>` inside org `:org` (requires a token with org repo-creation rights) |
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

POST /github/repos/my-org/my-app
Authorization: Bearer ghp_xxx
-> { "name": "my-app-a82f91cd", "owner": "my-org", "url": "...", "default_branch": "main" }

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

## API reference

`GET /docs` serves an interactive API reference generated from
`openapi.json`, rendered with [Scalar](https://github.com/scalar/scalar) —
the whole page is one `<script id="api-reference" data-url="docs/openapi.json">`
tag plus Scalar's CDN loader script, no build step or npm dependency.
`GET /docs/openapi.json` serves the raw document (`openapi.json` at the
repo root) for any other tool that wants to consume it directly (Postman,
Insomnia, codegen, etc.).

If you're deploying to Cloud Functions gen1, set `PUBLIC_BASE_URL` to this
function's actual public URL (e.g.
`https://us-central1-<project>.cloudfunctions.net/<function-name>`) so
that `/docs`' "Send Request" testing feature works. Without it, the
document's server URL is relative (`..`), which is correct per the OpenAPI
spec but gets resolved by Scalar against the `/docs` page URL rather than
the fetched document's own URL - on gen1, where the function name is a
required path segment this code never sees in `req.url`, that mismatch is
enough to drop the function name and send test requests to the bare
origin, which 404s before reaching this code at all (surfaced as GCP's own
"Page not found", not anything from this service). This doesn't affect
local dev or gen2/Cloud Run, which don't have that path-prefix quirk -
`PUBLIC_BASE_URL` is genuinely optional there.

## Health check

There's no dedicated health router — `GET /healthz` is answered directly by
the `SimpleRouterBuilder` root handler in `index.js` with `{ "status": "ok" }`.
Any other request that doesn't match `/github/...` or `/docs` gets a plain
404 from that same root handler.

## Notes

- `simple-router-builder` isn't published to the npm registry, so `package.json`
  pulls it directly from source: `"simple-router-builder": "github:dash-xd/simple-router-builder#main"`.
  `npm install` needs read access to that repo.
- Routing uses `simple-router-builder`'s `NewEmptyRouter()` — a thin wrapper
  around the standalone `router` package (the same routing engine Express's
  own `Router` is built on), not `express.Router()`. This project has no
  direct dependency on `express` at all. `req.body`/`req.query`/`res.json`/
  `res.redirect`/`res.locals` still work because `@google-cloud/functions-framework`
  (run via `npx`) wraps everything in its own Express app before `Main` is
  ever invoked - it parses the request body itself and attaches the full
  Express `req`/`res` prototype ahead of time.
- Data a middleware computes for downstream handlers — the Octokit client,
  the parsed upload files — lives on `res.locals` (`res.locals.octokit`,
  `res.locals.files`), not on `req`. `req` stays limited to what the
  request itself actually carries (`req.params`, `req.query`, `req.body`).
- Octokit clients are cached per Bearer token in a module-scope `Map`
  (`octokits` in `index.js`), for the life of the warm container.
- `@octokit/rest` is pinned to `^20` because later major versions are
  ESM-only and this project uses CommonJS (`require`), matching the Cloud
  Functions entry point convention.
- `openapi.json` uses a couple of genuine OpenAPI 3.2.0 additions where they
  fit naturally: the top-level `$self` field for document identity, and the
  new `Tag.summary` field.
