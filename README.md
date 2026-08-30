# github-cdn

Treats GitHub as a content store: an HTTP Cloud Run function that creates repos,
uploads files, snapshots branches, deletes files, and manages branches through
the GitHub Git Data API via Octokit — no local `git clone` involved.

`main` is the deployable Node.js implementation. The former lightweight
manifest-only composition is preserved on the `local` branch.

The repository is intentionally portable: no deployment secrets, GitHub
repository variables, organization names, project IDs, service-account emails,
or workload-identity configuration are required or embedded. Terraform receives
deployment identity and target information from the caller at apply time.

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

### Google IAM authentication

A private Cloud Run / Gen2 function uses:

```http
Authorization: Bearer <google id token>
```

Google validates that token and the caller's `roles/run.invoker` permission
before the request reaches the application. `github-cdn` deliberately does not
reimplement or emulate Google IAM.

For a direct authenticated call, both credentials are independent:

```text
Authorization: Bearer <google ID token>
X-GH-Device-Access-Token: <github token>
```

For local Functions Framework development there is no Google IAM layer, so only
the GitHub header is required.

## Local development

```bash
npm install
npm run dev
```

Then:

```bash
curl \
  -H "X-GH-Device-Access-Token: $GITHUB_TOKEN" \
  http://localhost:8080/github/repos/octocat/Hello-World/main
```

The `local` branch retains the previous Android Repo manifest that composes the
pinned JavaScript and Go development workspaces.

## Private deployment with Terraform

The Terraform module under `terraform/` creates:

- a dedicated source bucket with uniform bucket-level access and public access
  prevention;
- a dedicated runtime service account with no project roles granted by this
  module;
- a Gen2 Cloud Run function using the repository source;
- `roles/run.invoker` bindings only for explicitly supplied IAM members.

There is intentionally no `allUsers` binding. An empty `invoker_members` value
leaves the function private with no invoker added by this module.

Authenticate Terraform however is appropriate for your environment, then pass
the target configuration explicitly:

```bash
cd terraform
terraform init
terraform apply \
  -var="project_id=$PROJECT_ID" \
  -var="region=$REGION" \
  -var='invoker_members=["serviceAccount:caller@example.iam.gserviceaccount.com"]'
```

No `.tfvars` file is required. Local `.tfvars`, Terraform state, plans, and the
Terraform working directory are gitignored so deployment-specific values do not
accidentally become repository configuration.

Useful outputs:

```bash
terraform output -raw function_name
terraform output -raw function_uri
terraform output -raw runtime_service_account
```

The deployer needs the ordinary Google permissions required to build/deploy a
Gen2 function, create its source bucket and runtime service account, and act as
the runtime service account. Those permissions belong to the caller's GCP
bootstrap/IAM configuration, not this public repository.

## Test real Google IAM through a local proxy

Do not reproduce Google IAM middleware locally. `gcloud run services proxy`
provides a localhost endpoint while forwarding through the real deployed Cloud
Run service using the current Google identity.

The included smoke test first proves that a direct unauthenticated request is
rejected by Google, then starts the authenticated Cloud Run proxy and exercises
the GitHub API through localhost:

```bash
export PROJECT_ID="your-project"
export REGION="us-central1"
export SERVICE_NAME="$(terraform -chdir=terraform output -raw function_name)"
export GH_DEVICE_ACCESS_TOKEN="..."

bash scripts/private-proxy-smoke.sh
```

The identity used by `gcloud` must be one of the configured invokers. The proxy
handles Google authentication upstream; the localhost request still supplies
`X-GH-Device-Access-Token` because GitHub authorization remains an independent
application concern.

This gives the useful test boundary:

```text
local client
    |
    | X-GH-Device-Access-Token
    v
gcloud run services proxy
    |
    | real Google identity / ID token
    v
Cloud Run IAM
    |
    | authorized request only
    v
github-cdn
    |
    v
GitHub API
```

## Direct IAM invocation

When a proxy is not desired, mint an ID token for the service audience using an
identity that has `roles/run.invoker`:

```bash
GOOGLE_ID_TOKEN="$(
  gcloud auth print-identity-token \
    --impersonate-service-account="$INVOKER_SA" \
    --audiences="$FUNCTION_URL"
)"

curl \
  -H "Authorization: Bearer $GOOGLE_ID_TOKEN" \
  -H "X-GH-Device-Access-Token: $GITHUB_TOKEN" \
  "$FUNCTION_URL/github/repos/octocat/Hello-World/main"
```

## CI boundary

The repository's validation workflow intentionally requires no cloud
credentials. It runs the Node test suite and validates the Terraform module with
`terraform init -backend=false` and `terraform validate`.

Live deployment and IAM qualification should be performed by an external
control plane or by a clone's own environment, where temporary credentials and
project-specific values can be injected without coupling this public repository
to any particular organization.

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

## Security invariants

- GitHub tokens are request-scoped and never share the Google bearer header.
- `Authorization` is reserved for the deployment platform.
- `X-GH-Device-Access-Token` is the application GitHub credential header.
- The Terraform deployment is private by default and contains no `allUsers`
  invoker grant.
- Runtime identity is separate from deployer and invoker identities.
- The public repository contains no environment-specific cloud credentials or
  organization deployment variables.
- IAM smoke tests prove both rejection and successful invocation against the
  real Google-managed boundary rather than an application-level emulator.
