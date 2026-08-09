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
    client.js                  createOctokit(token) -> Octokit instance (personal access token)
    app-client.js               createInstallationOctokit / createAppLevelOctokit -> Octokit instances (GitHub App auth)
    repo-service.js            GitHub Git Data API service layer (createRepo, createOrgRepo, commitFiles, getBranchSnapshot, deleteFiles, createEmptyBranch, createBranchFrom)
  middleware/
    github-auth.js             githubAuth(createOctokit): returns a middleware that builds res.locals.octokit from the request's Bearer token
    app-auth.js                 appAuth(getInstallationOctokit): returns a middleware that builds res.locals.octokit as the app installation - no per-request token
    app-access.js                requireAppAccess({...}): authorizes /app calls via a trusted GCP caller identity (WIF), a shared secret, or both - see "Calling this from automation" below
    upload.js                  parseUpload: busboy multipart parser + SHA-256 content addressing; writes res.locals.files, plus objectPath()
    github-repos.js            one middleware function per /github route (createRepoHandler, uploadObjectsHandler, ...) plus handleError
    org-repos.js                createOrgRepoHandler: org-scoped repo creation, shared by /github (caller token) and /app (installation token)
    app-setup.js                 serveManifestForm / handleManifestCallback / listInstallationsHandler for /setup
    oauth-login.js               serveLoginPage / handleLoginCallback for /login - self-serve OAuth user-to-server login
    docs.js                    serveDocsPage / serveOpenApiDocument for /docs
```

There's no `routes/` directory: index.js imports the middleware functions
above and wires up the router itself, rather than importing a pre-built
router module.

## Three ways to authenticate

- **`/github`** — the caller brings their own GitHub personal access token
  (`Authorization: Bearer <token>`), forwarded straight through to Octokit.
  Whoever holds the token is authorized for whatever that token can do -
  personal or org, including org-owned repo creation, if the token is
  scoped for it.
- **`/app`** — the function authenticates to GitHub itself, as an
  installation of a GitHub App, using credentials configured on the
  function (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_INSTALLATION_ID`).
  No human is present in this flow at all - it's for server-to-server
  automation (CI, cron, etc) that doesn't want to manage its own GitHub
  credentials, not something an end user goes through. *Calling* `/app`
  itself is authorized by whichever strategy the deployment configures -
  a trusted GCP caller identity, a shared secret, or both; see below.
- **`/login`** — a human logs in with their own GitHub account (OAuth
  user-to-server) and gets back an ordinary GitHub token, which they then
  use at `/github`. This is the self-serve, multi-tenant path; `/app` is
  the no-user-present one. They're separate purposes, not one superseding
  the other.

`/app` reuses every `github-repos.js` handler, including repo creation:
`createOrgRepoHandler` (`src/middleware/org-repos.js`) only ever reads
`res.locals.octokit`, so it doesn't care whether that Octokit was built
from a caller's PAT or an installation token - it works identically from
either router. It's not the same handler as `/github`'s *personal*
`POST /repos/{name}`, though: installation tokens have no "authenticated
user" the way a PAT does, so `POST /user/repos` isn't available to them -
org-owned repos always go through `POST /orgs/{org}/repos`
(`createOrgRepo` in `repo-service.js`) instead, which is why the org route
takes `:org` explicitly (`POST /repos/{org}/{name}`) rather than assuming
"whoever the token belongs to". `/github` exposes both shapes side by
side - `POST /github/repos/{name}` for a personal repo, `POST
/github/repos/{org}/{name}` for an org-owned one - since a caller token
might be good for either.

Because `/app` has no caller-supplied token, it has no caller-side
authorization either - authenticating to *GitHub* as the installation says
nothing about who's allowed to *call this function*. `requireAppAccess`
(`src/middleware/app-access.js`) is the substitute, and it isn't one fixed
mechanism - it's a set of independent strategies, any one of which
authorizes a request:

- **A trusted GCP caller identity.** The bearer token is a Google-signed
  OIDC identity token, verified against Google's own public keys (via
  `google-auth-library`, not anything this service stores) rather than
  compared against a secret this service holds. If the token's `email`
  claim is in `TRUSTED_GCP_INVOKER_EMAILS` and its audience matches this
  deployment, the request is authorized. This is what a caller that
  already has a GCP identity - a Workload Identity Federation-
  authenticated GitHub Actions job being the common case - presents; see
  "Calling this from automation" below for how to mint that token.
  **Nothing needs to be generated, stored, or rotated by this service for
  a caller using this path** - the whole point of WIF is that the caller
  already proved who it is to GCP some other way.
- **A static shared secret.** `Authorization: Bearer <APP_ACCESS_SECRET>`,
  checked with a constant-time comparison. For callers with no GCP
  identity of their own to present. Treat it the same way you'd treat the
  GitHub App's own private key.

A deployment enables whichever strategy fits a given caller by setting
that strategy's env vars - both can be enabled at once for a mix of
callers, and leaving both unconfigured makes `/app` unreachable (500)
rather than silently open. This is deliberately pluggable rather than
"the one mechanism this project picked": different deployments, and
different callers of the *same* deployment, have different existing
identity systems, and `/app`'s job is to authorize the call, not to
mandate how a caller proves who it is.

`/login` doesn't have (or need) an equivalent gate: the OAuth token it
hands back is scoped to whatever the logged-in user can personally do,
further bounded by wherever the app is installed - GitHub itself is the
authorization boundary there, the same as any caller-supplied token at
`/github`. See "Self-serve login" below.

### Required env vars for `/app`

`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_INSTALLATION_ID`
are always required - they're how `/app` authenticates *to GitHub*. Of
the two authorization strategies below (how `/app` decides whether to
accept the *call* at all), configure at least one - both is fine too:

| Var | What |
| --- | --- |
| `GITHUB_APP_ID` | The App's numeric id. |
| `GITHUB_APP_PRIVATE_KEY` | The App's PEM private key. `\n`-escaped values (common when env vars can't hold real newlines) are unescaped automatically. |
| `GITHUB_APP_INSTALLATION_ID` | The installation id for your org. One installation per deployment - if the App is installed on multiple orgs, deploy separate function instances with different `GITHUB_APP_INSTALLATION_ID` values. |
| `TRUSTED_GCP_INVOKER_EMAILS` | Comma-separated GCP service account emails to trust via the identity-token strategy. Typically the WIF-impersonated service account your automation already authenticates as. |
| `APP_IDENTITY_AUDIENCE` | Audience the identity token must be minted for. Defaults to `PUBLIC_BASE_URL` if unset - only set this separately if the two need to differ. |
| `APP_ACCESS_SECRET` | Shared secret for the fallback strategy. Generate something long and random if you set it. |

The installation `Octokit` is built once (lazily, on first request that
needs it) and reused for the life of the warm container -
`@octokit/auth-app` handles refreshing the installation token internally,
so there's no need to rebuild the client per request.

### Required env vars for `/login`

| Var | What |
| --- | --- |
| `GITHUB_APP_CLIENT_ID` | The App's OAuth client id. Not secret - it's visible in the authorize URL regardless. |
| `GITHUB_APP_CLIENT_SECRET` | The App's OAuth client secret. Used exactly once per login, server-side only, to exchange a code for a token - never sent to the browser. |

Both come from the same `/setup/callback` response as `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`.
`/login` also needs `PUBLIC_BASE_URL` (already required for `/setup`) and,
to build the "install the app" link, `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`
(already required for `/app`) - it fetches the app's slug via JWT auth and
caches it, rather than requiring yet another env var for something
derivable from what's already configured.

## Calling this from automation (e.g. a GitHub Action)

This function is expected to be called by CI as much as by browsers, and
different callers reasonably want different things from it:

- A workflow that already has a usable GitHub token (a PAT stored as a
  workflow secret, or an installation token minted by some other step,
  e.g. [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token))
  can call `/github` directly with it - no interaction with this
  service's auth endpoints needed at all, and nothing below applies to it.
- A workflow with no GitHub token of its own, and no interest in
  managing one, wants `/app` - the function acts as the installed GitHub
  App on its behalf. That's the case this section is about.
- `/login`'s interactive OAuth flow is the one path a headless workflow
  *can't* drive itself (it requires a browser and a human to click
  "authorize") - it's for a human to run once, with the resulting token
  then stored wherever the automation reads its credentials from.

For the `/app` case: if your automation already authenticates to GCP via
Workload Identity Federation - a GitHub Actions job using
`google-github-actions/auth`, for instance - it already *has* a GCP
identity, and that's enough to authorize `/app` on its own, with no
separate secret to provision. WIF proves the workflow's identity to GCP;
the same auth step can also mint a Google-signed OIDC *identity token*
for that same service account, and `/app` verifies that token itself
(see `requireAppAccess` above) rather than requiring anything else:

```yaml
- uses: google-github-actions/auth@v2
  id: auth
  with:
    workload_identity_provider: ${{ vars.GCLOUD_WIF_PROVIDER }}
    service_account: ${{ vars.GCLOUD_SERVICE_ACCOUNT }}
    id_token_audience: ${{ vars.GITHUB_CDN_URL }}
    id_token_include_email: true

- run: |
    curl -H "Authorization: Bearer ${{ steps.auth.outputs.id_token }}" \
         -X POST "${{ vars.GITHUB_CDN_URL }}/app/repos/my-org/my-app"
```

Deploy with `TRUSTED_GCP_INVOKER_EMAILS` set to that service account's
email and `APP_IDENTITY_AUDIENCE` (or `PUBLIC_BASE_URL`) matching
`id_token_audience` above, and no `APP_ACCESS_SECRET` is needed at all
for this caller. `APP_ACCESS_SECRET` still exists for callers with no GCP
identity to present - set it too (or instead) if you have those; the two
strategies aren't mutually exclusive, and which one(s) you enable is a
deployment choice, not something hardcoded here.

This is also the underlying reason `/app` and `/github` are separate
routers rather than one router with conditional behavior: GCP identity
verification only makes sense for `/app`'s "acting as the app" case.
`/github` has no equivalent need for it - a caller there already proves
itself via the GitHub token it brings, independent of how it got that
token or what, if anything, authenticated it to GCP.

## Bootstrapping a GitHub App (`/setup`)

If you don't have a GitHub App yet, `/setup` creates one for an org using
[GitHub's manifest flow](https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) -
the same mechanism tools like Probot use, adapted for a stateless Cloud
Function. Three steps:

1. **`GET /setup?org=<org-login>`** — renders a page that auto-submits a
   form to `github.com/organizations/<org>/settings/apps/new`. You'll need
   to be signed into GitHub with admin rights on that org. Requires
   `PUBLIC_BASE_URL` to be set to this function's actual public URL (e.g.
   `https://us-central1-<project>.cloudfunctions.net/<function-name>`) -
   the function can't work this out from the request itself, because Cloud
   Functions strips the function-name path segment before the code ever
   sees `req.url` (the same constraint that shaped `/docs`' relative URLs).
2. **Confirm on GitHub.** GitHub creates the App and redirects to
   `GET /setup/callback?code=...`.
3. **`GET /setup/callback`** exchanges that one-time code for the App's
   real credentials and returns them as JSON: `id` (→ `GITHUB_APP_ID`),
   `pem` (→ `GITHUB_APP_PRIVATE_KEY`), `client_id` (→ `GITHUB_APP_CLIENT_ID`),
   `client_secret` (→ `GITHUB_APP_CLIENT_SECRET`), `webhook_secret`.
   **This is the only time they're ever shown - nothing is stored
   anywhere.** Copy what you need into the function's env vars and
   redeploy.

Then, once the App is installed on the org (GitHub prompts for this as
part of app creation, or install it manually from the App's settings
page): **`GET /setup/installations`** lists installations using app-level
(JWT) auth - no installation id required yet - so you can read off the
right `GITHUB_APP_INSTALLATION_ID`.

The manifest requests `contents: write` and `metadata: read` on
repositories, and `organization_administration: write` at the org level
(required to create repos via the App - see
[GitHub's repo-creation permission requirements](https://docs.github.com/rest/repos/repos#create-an-organization-repository)).
No webhook is requested (`default_events: []`, no `hook_attributes`) -
this function is request/response only, it doesn't handle webhook events.

**`/setup` and `/app` are unauthenticated and authenticated respectively,
but neither is meant to be a public-facing feature.** `/setup` is a
one-time admin bootstrap action; if it's reachable by anyone, the worst
case is someone else completing *their own* app-creation flow against your
redirect URL, which only shows *them* credentials for an app *they* just
created - not a compromise of anything of yours. `/app`'s exposure is
real, though: it performs privileged repo operations across your org using
credentials the caller never has to prove they should have access to,
authorized only by whatever `requireAppAccess` strategy you've configured
(see "Calling this from automation" above). If this function is deployed
with `--allow-unauthenticated` (needed for `/github`, `/docs`, `/login`,
and `/healthz` to be reachable at all), that in-app check is the only
thing standing between the internet and `/app` - there's no IAM-level way
to protect just one router within a single Cloud Function, so a
misconfigured or absent `requireAppAccess` strategy is a real exposure,
not a theoretical one. Consider whether `/app` and `/setup` belong in a
separate, more tightly-scoped deployment instead of alongside the
public-facing routes, if that risk doesn't sit well with your threat
model. `/login` is meant to be public - see below.

## Self-serve login (`/login`)

The alternative to `/app` for actual end users. Flow:

1. **`GET /login`** renders a page with two links: "Log in with GitHub"
   (GitHub's OAuth authorize URL) and "Install the GitHub App"
   (`github.com/apps/<slug>/installations/new`). Before rendering, it sets
   a random `state` value in a short-lived `HttpOnly` cookie
   (`SameSite=Lax`, 5 minute expiry) and embeds the same value in the
   authorize URL.
2. The user logs into GitHub and authorizes. GitHub redirects to
   **`GET /login/callback?code=...&state=...`**.
3. The callback checks `state` against the cookie (CSRF protection - this
   is the standard reason OAuth flows carry a `state` param; without it, a
   redirect to this callback could be triggered by anyone, not just a
   flow this server actually started), then exchanges `code` for the
   user's own access token via `github.com/login/oauth/access_token` -
   the one step that has to be server-side, since it needs
   `GITHUB_APP_CLIENT_SECRET`.
4. The token comes back via a redirect to `/login#access_token=...` - the
   URL *fragment*, not a query string, so it's never sent to any server or
   captured in logs. `/login`'s inline script reads `location.hash` on
   load and displays it.

That token is an ordinary GitHub personal-style access token from that
point on - scoped to whatever the user can do, further bounded by
wherever the app is installed. It's used directly against `/github`;
there's no separate "authenticated user" API surface, because `/github`
already accepts any caller-supplied token regardless of how the caller
got it.

`SameSite=Lax` on the state cookie is required, not just a reasonable
default - `Strict` would drop the cookie on the top-level navigation back
from `github.com`, breaking the state comparison on every login.

## Layered auth in `index.js`

`githubAuth` and `appAuth` are both factories rather than middleware
themselves: each takes a "give me an authenticated Octokit" closure and
returns the actual `(req, res, next)` middleware. Neither
`src/middleware/github-auth.js` nor `src/middleware/app-auth.js` requires
`src/lib/client.js` / `src/lib/app-client.js` directly - `index.js` is the
only place that does, and it's what injects `lazyCreateOctokit` /
`getInstallationOctokit` into them. This is the same pattern in both
places: the middleware knows *how* to attach an Octokit client to the
request, `index.js` decides *which* one.

`githubRouter`, `appRouter`, and `loginRouter` are all built with
`NewEmptyRouter()` from `simple-router-builder` — a thin wrapper around
the standalone `router` package (the same routing engine Express's own
`Router` is built on), not `express.Router()`. This project has no direct
dependency on `express` at all.

That still works with `res.json`/`res.status`/`res.redirect`/`res.locals`/`req.query`/`req.body`
because `@google-cloud/functions-framework` (run via `npx`, see below)
wraps everything in its own Express app *before* calling `Main` — it parses
the request body itself (json/urlencoded/raw/text, by content-type) and
attaches the full Express `req`/`res` prototype ahead of time. So by the
time a request reaches a router, `req.body` is already populated, `res.locals`
is already an object, and `res.json`/`res.redirect` already exist — the
routers just need to route.

Data a middleware computes for downstream handlers — the Octokit client,
the parsed upload files — lives on `res.locals` (`res.locals.octokit`,
`res.locals.files`), not on `req`. `req` stays limited to what the request
itself actually carries (`req.params`, `req.query`, `req.body`).

## API reference

`GET /docs` serves an interactive API reference generated from
`openapi.json`, rendered with [Scalar](https://github.com/scalar/scalar) —
the whole page is one `<script id="api-reference" data-url="docs/openapi.json">`
tag plus Scalar's CDN loader script, no build step or npm dependency.
Scalar was chosen over Swagger UI because it renders OpenAPI 3.1/3.2
documents natively; Swagger UI's 3.2 support landed later and is less
complete as of this writing. `GET /docs/openapi.json` serves the raw
document (`openapi.json` at the repo root) for any other tool that wants
to consume it directly (Postman, Insomnia, codegen, etc.).

The spec documents every route below, including `/app`, `/setup`, and
`/login`, request/response schemas, all three security schemes
(`githubToken` for `/github`; `accessSecret` and `gcpIdentityToken` for
`/app`, either of which satisfies it), and worked examples.

## Health check

There's no dedicated health router — `GET /healthz` is answered directly by
the `SimpleRouterBuilder` root handler in `index.js` with `{ "status": "ok" }`.
Any other request that doesn't match `/github/...`, `/app/...`, `/setup/...`,
`/login/...`, `/docs`, or `/healthz` gets a plain 404 from that same root
handler.

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

Then open `http://localhost:8080/docs` for the API reference. `/app`,
`/setup`, and `/login` will error clearly (not silently misbehave) until
their required env vars above are set - `/github`, `/docs`, and `/healthz`
need no configuration at all.

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

## Routes (mounted under `/app` — installation auth, see above)

| Method | Path | Body / Query | Description |
| --- | --- | --- | --- |
| POST | `/repos/:org/:name` | `{ private?: boolean }` | Create a repo named `<name>-<random8>` inside `:org` (same handler as `/github`'s org-repo route) |
| POST | `/repos/:owner/:repo/upload` | same as `/github` | Same handler as `/github`'s upload route |
| GET | `/repos/:owner/:repo/:branch` | same as `/github` | Same handler as `/github`'s snapshot route |
| DELETE | `/repos/:owner/:repo/:branch` | same as `/github` | Same handler as `/github`'s delete route |
| POST | `/repos/:owner/:repo/branches` | same as `/github` | Same handler as `/github`'s create-empty-branch route |
| POST | `/repos/:owner/:repo/branches/from` | same as `/github` | Same handler as `/github`'s branch-from route |

Every `/app` request needs `Authorization: Bearer <token>`, where `token`
is either a Google-signed identity token for a `TRUSTED_GCP_INVOKER_EMAILS`
entry, or `APP_ACCESS_SECRET` - see "Calling this from automation" above.

## Routes (mounted under `/setup` — see "Bootstrapping a GitHub App" above)

| Method | Path | Query | Description |
| --- | --- | --- | --- |
| GET | `/` | `?org=<org-login>` | Start the manifest flow for `org` |
| GET | `/callback` | `?code=...` (from GitHub's redirect) | Exchange the code for the new App's credentials (shown once) |
| GET | `/installations` | — | List this App's installations, to find `GITHUB_APP_INSTALLATION_ID` |

## Routes (mounted under `/login` — see "Self-serve login" above)

| Method | Path | Query | Description |
| --- | --- | --- | --- |
| GET | `/` | — | Login page: "log in with GitHub" and "install the app" links |
| GET | `/callback` | `?code=...&state=...` (from GitHub's redirect) | Exchange the code for the user's own token, redirect back to `/login#access_token=...` |

## Notes

- `simple-router-builder` isn't published to the npm registry, so `package.json`
  pulls it directly from source: `"simple-router-builder": "github:dash-xd/simple-router-builder#main"`.
  `npm install` needs read access to that repo.
- Routing uses `simple-router-builder`'s `NewEmptyRouter()` end to end — this
  project doesn't depend on `express` at all. `req.body`/`req.query`/`res.json`/`res.redirect`/`res.locals`
  still work because `@google-cloud/functions-framework` supplies them via its
  own internal Express app before `Main` is ever invoked.
- Octokit clients for `/github` are cached per Bearer token in a
  module-scope `Map` (`octokits` in `index.js`); the `/app` Octokit and
  `/login`'s app slug lookup are each a single cached instance/value. All
  live only as long as the warm container does.
- `@octokit/rest` is pinned to `^20` and `@octokit/auth-app` to `^6`
  because later major versions are ESM-only and this project uses
  CommonJS (`require`), matching the Cloud Functions entry point convention.
  `/login`'s OAuth token exchange uses Node's built-in `fetch` (stable
  since Node 18, matching this project's `engines.node` and the deployed
  `nodejs22` runtime) rather than adding another dependency.
- `google-auth-library` is used only by `/app`'s GCP-identity-token
  strategy (`src/middleware/app-access.js`), to verify a caller-presented
  identity token against Google's own keys. It's the standard library for
  this on Node, and the same one Google's own Cloud Run/Functions
  authentication docs point to for verifying identity tokens
  application-side.
- `openapi.json` uses a couple of genuine OpenAPI 3.2.0 additions where they
  fit naturally: the top-level `$self` field for document identity, and the
  new `Tag.summary` field. It doesn't reach for 3.2 features that don't
  apply to this API's shape (streaming media types, `additionalOperations`
  for non-standard verbs).
