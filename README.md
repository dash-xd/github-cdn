# github-cdn

`main` is the durable composition and deployment-kit surface for github-cdn. Runtime implementations live on dedicated source branches; `default.xml` is the sole promoted revision ledger for the JavaScript and Go implementations.

This repository is not a standing deployment. It is intended to be forked or cloned by consumers and imported by Huram while iterating on candidate compositions.

## Branch model

- `claude/token-only-github-cdn` — JavaScript token-only implementation.
- `codex/go-gh-token-cdn` — Go token-only implementation.
- `main` — promoted `default.xml`, Android Repo composition helper, generic Terraform deployment kit, and composition-kit validation.
- `candidate/*` — candidate composition surfaces prior to promotion.
- `archive/*` — prior promoted `main` generations preserved when a newer qualified composition replaces them.

A runtime implementation should not be copied into `main` merely because it is the current qualification target. Mutable implementation branch heads are development inputs; immutable manifest revisions are promoted outputs.

## Compose

Install the Android Repo launcher, then materialize one implementation from the exact revisions in `default.xml`:

```bash
bash scripts/compose.sh javascript .composition
# or
bash scripts/compose.sh golang .composition
```

The script emits `.composition/deployment.json` with the selected source directory, Cloud Run functions runtime, and entry point. `default.xml` remains authoritative for source revisions.

You can also use Repo directly:

```bash
repo init \
  -u https://github.com/dash-xd/github-cdn.git \
  -b main \
  -m default.xml
repo sync -c --no-tags
```

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

`main` validates the composition kit itself: Terraform formatting/validation and Android Repo materialization of both manifest projects. Runtime unit tests and live IAM/Git behavior belong to the implementation branches and Huram qualification, not to the composition repository's durable branch.

## Qualification and promotion

Huram owns ephemeral live qualification. It locks an implementation branch to an immutable SHA, composes a disposable qualification repository, deploys with profile-owned infrastructure, runs the live IAM/Git correctness proof, destroys the candidate, and records an exact machine result.

Only a successful exact qualification should advance the corresponding revision in `default.xml`. Before promoting a replacement composition to `main`, preserve the previous `main` as an archive branch. `main` therefore describes promoted evidence, not whatever mutable implementation branch happens to be newest.
