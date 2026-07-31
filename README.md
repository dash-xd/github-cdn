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
        ├── parseUpload       (middleware/upload.js)         busboy multipart parser, used only on the upload route
        └── repo-service.js                                  GitHub service layer (git.createBlob/createTree/createCommit/updateRef, etc.)
```

Auth is per-request and stateless: each call must send `Authorization: Bearer <github token>`.
No token is stored on the server.

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
| POST | `/repos/:owner/:repo/upload` | multipart form: one or more files, optional `branch` field | Commit uploaded files, returns repo name + commit sha |
| GET | `/repos/:owner/:repo/:branch` | `?content=true` to include base64 file content | Snapshot a branch's file tree without cloning |
| DELETE | `/repos/:owner/:repo/:branch` | `{ paths: string[] }` (or `{ path: string }`) | Delete one or more files in a single commit |
| POST | `/repos/:owner/:repo/branches` | `{ branch: string }` | Create a new empty (orphan) branch |
| POST | `/repos/:owner/:repo/branches/from` | `{ branch: string, source: string }` | Create a new branch from an existing branch |

### Examples

```
POST /github/repos/my-app
Authorization: Bearer ghp_xxx
-> { "name": "my-app-a82f91cd", "owner": "...", "url": "...", "default_branch": "main" }

curl -H "Authorization: Bearer TOKEN" \
     -F "index.html=@index.html" -F "app.js=@app.js" -F "branch=main" \
     localhost:8080/github/repos/user/my-app-a82f91cd/upload

GET /github/repos/user/my-app-a82f91cd/main?content=true

DELETE /github/repos/user/my-app-a82f91cd/main
{ "paths": ["app.js"] }

POST /github/repos/user/my-app-a82f91cd/branches
{ "branch": "empty-branch" }

POST /github/repos/user/my-app-a82f91cd/branches/from
{ "branch": "feature", "source": "main" }
```

## Notes

- `simple-router-builder` mirrors the pattern used in the `haram-abi` repo; point npm at whatever registry that package is published to if it isn't on the public npm registry in your environment.
- `@octokit/rest` is pinned to `^20` because `^21` and later are ESM-only and this project uses CommonJS (`require`), matching the Cloud Functions entry point convention.
