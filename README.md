# github-cdn

`main` is the durable Android Repo manifest surface for the token-only implementations. Runtime functionality stays on dedicated source branches and is pinned here by exact commit SHA.

- JavaScript token-only source: `claude/token-only-github-cdn` @ `bd1038934d87338fcb9b3521c659bee8c1b60201`
- Go token-only source: `codex/go-gh-token-cdn` @ `80f4f3e85cd920cac17bd3caeceba2d709a4ece3`

## Compose and verify

`default.xml` is the composition contract. The repository-owned smoke script initializes Android Repo against this repository, explicitly selects `default.xml`, syncs the exact revisions, and then runs the source checks:

```bash
scripts/repo-smoke.sh
```

Equivalent composition steps are:

```bash
repo init \
  -u https://github.com/dash-xd/github-cdn.git \
  -b main \
  -m default.xml
repo sync -c --no-tags
```

This produces `javascript/` and `golang/` worktrees at the exact revisions above. The synced manifest checkout then runs `.repo/manifests/scripts/smoke-local.sh`, which verifies the exact HEADs, runs the JavaScript unit tests, and runs `go mod tidy && go test ./...` for the Go implementation.

## CI boundary

`.github/workflows/repo-smoke.yml` currently provides Node, Go, and the lightweight Android `repo` launcher, then calls `scripts/repo-smoke.sh`. The composition logic deliberately lives in the script rather than the workflow so it can later be invoked from Nix without carrying GitHub Actions coupling into the composition contract.

Full token-only API qualification remains owned by Huram's ephemeral deployment/test control plane rather than by `main`.
