# github-cdn

Treats GitHub as a content store: an HTTP Cloud Function that creates repos,
uploads files, snapshots branches, deletes files, and manages branches
through the GitHub Git Data API via Octokit — no local `git clone` involved.

## Architecture

```
index.js (Main, SimpleRouterBuilder)
  ├── /healthz               -> src/routes/health.js
  └── /github                -> src/routes/github-repos.js
        ├── githubAuth        (middleware/github-auth.js)   builds an Octokit client from the request's Bearer token
        ├── parseUpload       (middleware/upload.js)         busboy multipart parser + SHA-256 content addressing
        └── repo-service.js                                  GitHub service layer (git.createBlob/createTree/createCommit/updateRef, etc.)
```

`index.js` is the entire Cloud Function entry point:

```js
exports.Main = new SimpleRouterBuilder()
    .withChildRouter("/github", githubRouter)
    .withChildRouter("/healthz", healthRouter)
    .withRootHandler((req, res) => {
        res.statusCode = 404;
        res.end("Not found");
    })
    .build();
```

`@google-cloud/functions-framework` (run via `npx`, see below) wraps this in
its own Express app, so by the time `Main(req, res)` is invoked, `req`/`res`
already carry the full Express prototype (`res.json`, `res.status`, etc.) —
the child routers just need to be ordinary `express.Router()` instances, no
extra wrapping required.

Auth is per-request and stateless: each call must send `Authorization: Bearer <github token>`.
No token is stored on the server.

## Object model

Uploads are content-addressed, not path-addressed:

```
upload -> raw content -> SHA-256 -> immutable object -> Git-backed object store
```

`parseUpload` (`src/middleware/upload.js`) hashes each uploaded file's bytes
and stores it at `objects/<hash prefix>/<hash>` via `commitFiles`
(`src/github/repo-service.js`). The upload path doesn't know or care whether
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
- `@octokit/rest` is pinned to `^20` because `^21` and later are ESM-only and this project uses CommonJS (`require`), matching the Cloud Functions entry point convention.
