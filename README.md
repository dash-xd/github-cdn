# github-cdn

Treats GitHub as a content store: an HTTP Cloud Function that creates repos,
uploads files, snapshots branches, deletes files, and manages branches through
the GitHub Git Data API via Octokit — no local `git clone` involved.

This branch is the stateless, token-only version. The caller always brings its
own GitHub token; the service stores no GitHub credential and has no GitHub App
installation identity of its own.

## Authentication model

There are two independent authentication layers and they intentionally use
different headers.

### GitHub authentication

The GitHub credential is always supplied as:

```http
X-GH-Device-Access-Token: <github token>
```

`github-cdn` consumes only that header when constructing its request-scoped
Octokit client. It does not interpret `Authorization` as a GitHub credential.

This fixed application-level contract avoids a collision with deployment
platform authentication and keeps the same GitHub behavior in every runtime.

### Google IAM authentication

When the function is deployed with Google IAM invocation required, Google uses:

```http
Authorization: Bearer <google id token>
```

That token is validated by Cloud Run / Cloud Functions before the request
reaches `github-cdn`. The application does not parse or validate the Google
token itself.

This produces two deployment modes without changing application code:

```text
GitHub-only invocation
  X-GH-Device-Access-Token: <github token>

Google-IAM + GitHub invocation
  Authorization: Bearer <google id token>
  X-GH-Device-Access-Token: <github token>
```

The deployment pipeline should choose whether the service allows
unauthenticated platform invocation. In an IAM-protected deployment, grant
`roles/run.invoker` only to the intended caller identity. In a GitHub-only
deployment, the endpoint may be reachable without Google IAM and GitHub remains
the application authorization boundary.

Do not overload `Authorization` with the GitHub token. A private Gen2 function
needs that header for Google's ID token, and treating it as a GitHub token would
make the two auth layers mutually exclusive.

## Layout

```text
index.js                       Cloud Function entry point and router
openapi.json                   OpenAPI document
src/
  lib/
    client.js                  createOctokit(token)
    repo-service.js            GitHub Git Data API service layer
  middleware/
    github-auth.js             reads X-GH-Device-Access-Token
    upload.js                  multipart parser + SHA-256 addressing
    github-repos.js            repository/object/branch handlers
    org-repos.js               org-scoped repository creation
    docs.js                    /docs and /docs/openapi.json

test/
  github-auth.test.js          auth-layer separation tests
  repo-service.test.js         Git data behavior tests
```

## Object model

Uploads are content-addressed rather than caller-path-addressed:

```text
upload -> raw content -> SHA-256 -> immutable object -> Git-backed object store
```

`parseUpload` hashes each uploaded file and stores it at
`objects/<hash prefix>/<hash>`. The original filename and content type are
informational metadata only and never determine the object path. Re-uploading
identical bytes is therefore naturally idempotent.

## Run locally

```bash
npm install
npm run dev
```

Then use the GitHub token header directly:

```bash
curl \
  -H "X-GH-Device-Access-Token: $GITHUB_TOKEN" \
  -F "file=@example.tar.gz" \
  -F "branch=main" \
  http://localhost:8080/github/repos/user/repo/upload
```

No Google bearer token is needed locally unless the local endpoint itself is
fronted by something enforcing Google IAM.

## Invoke an IAM-protected deployment

Mint the Google ID token for the service URL using an identity that has
`roles/run.invoker`, while keeping the GitHub device token separate:

```bash
GOOGLE_ID_TOKEN="$(
  gcloud auth print-identity-token \
    --impersonate-service-account="$INVOKER_SA" \
    --audiences="$FUNCTION_URL"
)"

curl \
  -H "Authorization: Bearer $GOOGLE_ID_TOKEN" \
  -H "X-GH-Device-Access-Token: $GITHUB_TOKEN" \
  "$FUNCTION_URL/github/repos/user/repo/main"
```

For an ephemeral deployment pipeline, the clean lifecycle is:

1. deploy the function with IAM invocation required;
2. grant an ephemeral or designated test service account `roles/run.invoker`;
3. use the deployment's temporary GCP credential to impersonate that invoker
   and mint a short-lived ID token for the function audience;
4. invoke with the Google ID token in `Authorization` and the GitHub device
   token in `X-GH-Device-Access-Token`;
5. destroy the IAM binding/service account together with the test deployment.

This keeps deployer, invoker, runtime, and GitHub identities independent.

## Routes

All GitHub routes are mounted under `/github`.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/repos/:name` | Create a repository under the caller's account |
| POST | `/repos/:org/:name` | Create a repository in an organization |
| POST | `/repos/:owner/:repo/upload` | Upload content-addressed objects |
| GET | `/repos/:owner/:repo/:branch` | Snapshot a branch without cloning |
| DELETE | `/repos/:owner/:repo/:branch` | Delete objects by tree path or object ID |
| POST | `/repos/:owner/:repo/branches` | Create an empty branch |
| POST | `/repos/:owner/:repo/branches/from` | Create a branch from another branch |

## API reference

`GET /docs` serves the interactive API reference and
`GET /docs/openapi.json` serves the raw document.

If deploying to Cloud Functions gen1, `PUBLIC_BASE_URL` can be set to the
function's actual URL so interactive requests preserve the function-name path
segment. Gen2 / Cloud Run does not have that path-prefix issue.

## Security invariants

- GitHub tokens are request-scoped and are not cached by raw credential value.
- `Authorization` is reserved for the deployment platform and ignored by
  GitHub authentication middleware.
- `X-GH-Device-Access-Token` is the only application GitHub credential header.
- Enabling Google IAM is a deployment concern, not an application-mode parser.
- IAM-protected smoke tests should verify unauthenticated requests fail and the
  designated invoker succeeds.
