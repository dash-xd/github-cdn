# Go `gh` CDN design

This branch keeps the hardened token-only JavaScript router intact and adds a parallel Go implementation.

## Why `go-gh`, not the whole `gh` command tree

The reusable supported boundary of GitHub CLI is `github.com/cli/go-gh/v2`. It carries the same authentication/host conventions and GitHub API transport used by `gh`, but can accept an explicit caller token per client. That preserves the token-only trust model: the HTTP service stores no GitHub credential and does not mutate process-global `GH_TOKEN` state.

Importing `github.com/cli/cli/v2/pkg/cmd/...` would embed the CLI's Cobra/factory/internal command graph into a server. Those packages are designed to assemble the interactive CLI, not as a stable server library API, and make the resulting binary much larger and more tightly coupled to CLI internals. `gh.Exec` is also intentionally not used because it shells out to a separately installed `gh` executable.

The resulting binary therefore has the GitHub CLI client stack built in, but does not need an external `gh` binary.

## Package boundaries

- `cdn`: content-addressed object primitives. Object IDs are raw SHA-256 and storage paths remain `objects/<first-two>/<sha256>`.
- `ghservice`: independently callable GitHub operations. It owns REST/GraphQL selection, optimistic concurrency, and GitHub error translation.
- `router`: Chi HTTP adapter. It depends on a small `Service` interface and has an injectable `Factory`, so the same service functions can be used without HTTP or replaced in tests.
- `cmd/localserve`: ordinary binary for local execution and smoke tests.

`router.New()` returns `http.Handler`, which is the shape expected by `dash-xd/gospace-minimal`'s router-source drop-in for Cloud Functions Gen 2.

## REST versus GraphQL

Normal content mutations use GraphQL `createCommitOnBranch` with `expectedHeadOid`.

That is a better primitive than the JavaScript implementation's separate REST calls for blob creation, tree creation, commit creation, and ref update. GitHub applies the file additions/deletions and advances the branch as one mutation. A stale `expectedHeadOid` becomes `STALE_DATA`; `ghservice` re-reads the head and retries with bounded randomized backoff.

REST remains appropriate for capabilities that are naturally Git Database operations or do not have an equivalent mutation used here:

- repository creation;
- reading refs/commits/recursive trees/blobs for branch snapshots;
- creating a genuinely orphan branch (blob -> tree -> root commit -> ref);
- creating a new ref from an existing branch.

The snapshot path deliberately keeps the JavaScript branch's fail-closed behavior when GitHub reports a truncated recursive tree.

## HTTP parity

The Go router retains the token-only routes:

- `POST /github/repos/{name}`
- `POST /github/repos/{org}/{name}`
- `POST /github/repos/{owner}/{repo}/upload`
- `GET /github/repos/{owner}/{repo}/{branch...}`
- `DELETE /github/repos/{owner}/{repo}/{branch...}`
- `POST /github/repos/{owner}/{repo}/branches`
- `POST /github/repos/{owner}/{repo}/branches/from`
- `GET /docs`
- `GET /docs/openapi.json`

Chi's wildcard capture is intentional for the snapshot/delete routes: branch names containing `/`, such as `feature/foo`, remain one branch parameter.

## Deployment shape

For local Actions smoke testing, check out this module and `dash-xd/gospace-minimal`, replace this module to the local checkout, and make the gospace router source return `router.New()`. `gospace-minimal` then builds and runs its `localserve` binary exactly as it does for other Go routers.

For Cloud Functions Gen 2, the same import is dropped into `gospace-minimal`; its existing bare-function wrapper remains the GCF entry point. No Cloud Functions-specific code belongs in this module.
