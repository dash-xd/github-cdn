# github-cdn

`main` is the durable composition and deployment-kit surface for github-cdn. Runtime implementations live on dedicated source histories in the same repository. `composition.json` is the semantic composition manifest; `default.xml` is the backwards-compatible Android Repo materialization manifest for the same pinned commits.

This repository is not a standing deployment. It is intended to be forked or cloned by consumers and imported by Huram while iterating on candidate compositions.

## Git composition model

The repository deliberately uses multiple root histories for independently buildable router implementations:

- `router/javascript` — stable human locator for the JavaScript router lineage.
- `router/go` — stable human locator for the Go router lineage.
- `main` — orchestration authority and exact promoted composition.
- `codex/*` — temporary development branches.
- `candidate/*` — temporary qualification/composition branches.
- `archive/*` — optional historical orchestration generations.

The role refs are discovery names, not versions. A promoted composition always records full immutable commit SHAs:

```text
role ref       = human locator / implementation lineage
commit SHA     = immutable component identity
main commit    = immutable composition identity
worktree       = materialized component identity
```

A role ref may advance after a composition is promoted. That does not change the composition pinned by `main` until the manifest is deliberately updated.

The older implementation branch names remain available for compatibility. New orchestration should prefer the stable role refs above rather than treating lifecycle-oriented branch names as component identities.

## Composition manifests

`composition.json` names each logical component, its repository, stable role ref, exact commit, workspace path, and deployment metadata. For example:

```json
{
  "schema": 1,
  "kind": "github-cdn.git-composition",
  "components": {
    "go-router": {
      "repository": "dash-xd/github-cdn",
      "ref": "router/go",
      "commit": "49fdb48a973865802d77fe1657e1338df5ac79e0"
    }
  }
}
```

`default.xml` remains supported and continues to pin the same source commits for Android Repo consumers. CI verifies that the two manifests agree. This lets existing `repo init` / `repo sync` consumers continue unchanged while Huram and other orchestration can consume the simpler Git component model directly.

A runtime implementation should not be copied into `main` merely because it is the current qualification target. Mutable implementation refs are development/discovery inputs; immutable manifest revisions are promoted outputs.

## Compose

Install the Android Repo launcher, then materialize one implementation from the exact revisions in `default.xml`:

```bash
bash scripts/compose.sh javascript .composition
# or
bash scripts/compose.sh golang .composition
```

The script emits `.composition/deployment.json` with the selected source directory, Cloud Run functions runtime, and entry point. `composition.json` and `default.xml` describe the same promoted source identity; `default.xml` remains the materialization input for this compatibility path.

You can also use Repo directly:

```bash
repo init \
  -u https://github.com/dash-xd/github-cdn.git \
  -b main \
  -m default.xml
repo sync -c --no-tags
```

Huram-native composition does not need Android Repo for same-repository components. It may resolve a component from `composition.json`, verify the exact commit, and materialize an exact worktree from the repository object database.

## Terraform

`terraform/` deploys an already-composed source directory as an IAM-private Cloud Run function. It is implementation-neutral; callers choose `source_dir`, `runtime`, and `entry_point` rather than keeping separate JavaScript and Go deployment stacks.

Example after composing JavaScript:

```bash
terraform -chdir=terraform init
terraform -chdir=terraform apply \
  -var="project_id=my-project" \
  -var="source_dir=../.composition/javascript" \
  -var="runtime=nodejs24" \
  -var="entry_point=Main"
```

Invoker IAM is explicit through `invoker_members`; an empty set does not create a public invoker binding.

## Validation boundary

`main` validates the composition kit itself: manifest consistency, Terraform formatting/validation, and Android Repo materialization of both manifest projects. Runtime unit tests and live IAM/Git behavior belong to the implementation histories and Huram qualification, not to the composition repository's durable branch.

## Qualification and promotion

Huram owns ephemeral live qualification. The intended progression is:

```text
candidate implementation
        ↓ qualify exact commit
stable role ref (router/go or router/javascript)
        ↓ deliberate composition promotion
main composition.json + default.xml
```

Huram locks an implementation to an immutable SHA, materializes or composes a disposable qualification source tree, deploys with profile-owned infrastructure, runs the live IAM/Git correctness proof, destroys the candidate, and records exact machine evidence.

Only a successful exact qualification should advance a component commit in the promoted manifests. Before promoting a replacement composition to `main`, preserving the previous `main` as an archive ref remains optional historical bookkeeping; the previous main commit is already immutable Git history. `main` therefore describes promoted evidence, not whatever mutable implementation ref happens to be newest.
