# github-cdn

`main` is the durable Android Repo manifest surface for the token-only implementations. Runtime functionality stays on dedicated source branches; `default.xml` is the single source of truth for which revisions compose the current qualified workspace.

## Compose

Android Repo consumes `default.xml` directly:

```bash
repo init \
  -u https://github.com/dash-xd/github-cdn.git \
  -b main \
  -m default.xml
repo sync -c --no-tags
```

The manifest determines the repositories, local paths, and revisions. Consumers should not duplicate those revision values elsewhere.

## CI boundary

`.github/workflows/repo-smoke.yml` currently installs the lightweight Android `repo` launcher and the required language toolchains, runs `repo init -m default.xml` and `repo sync`, then tests the resulting `javascript/` and `golang/` workspaces.

The workflow intentionally does not contain independent source SHAs. Moving this composition to Nix later should change the executor/toolchain provisioning, not the `default.xml` composition contract.

Full token-only API qualification remains owned by Huram's ephemeral deployment/test control plane rather than by `main`.
