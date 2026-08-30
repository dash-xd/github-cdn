# github-cdn

`main` is the durable Android Repo manifest surface for the token-only implementations. Runtime functionality stays on dedicated source branches and is pinned here by exact commit SHA.

- JavaScript token-only source: `claude/token-only-github-cdn` @ `bd1038934d87338fcb9b3521c659bee8c1b60201`
- Go token-only source: `codex/go-gh-token-cdn` @ `80f4f3e85cd920cac17bd3caeceba2d709a4ece3`

## Sync

```bash
repo init -u https://github.com/dash-xd/github-cdn.git -b main
repo sync -c --no-tags
```

This produces `javascript/` and `golang/` worktrees at the exact revisions above.

## Lightweight local verification

From the Repo workspace root:

```bash
.repo/manifests/scripts/smoke-local.sh "$PWD"
```

The script verifies both exact revisions, runs the JavaScript unit tests, and runs the Go test suite. Full token-only API qualification is owned by Huram's ephemeral deployment/test control plane rather than by `main`.
