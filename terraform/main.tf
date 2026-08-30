resource "random_id" "source" {
  byte_length = 4
}

locals {
  source_dir = abspath("${path.module}/${var.source_dir}")
}

resource "google_service_account" "runtime" {
  account_id   = substr(replace("${var.function_name}-runtime", "_", "-"), 0, 30)
  display_name = "${var.function_name} runtime"
}

resource "google_storage_bucket" "source" {
  name                        = "${var.project_id}-${var.function_name}-src-${random_id.source.hex}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
}

data "archive_file" "source" {
  type        = "zip"
  source_dir  = local.source_dir
  output_path = "${path.module}/.terraform/github-cdn-source.zip"

  excludes = [
    ".git",
    ".github",
    ".repo",
  ]
}

resource "google_storage_bucket_object" "source" {
  name   = "source-${data.archive_file.source.output_sha256}.zip"
  bucket = google_storage_bucket.source.name
  source = data.archive_file.source.output_path
}

resource "google_cloudfunctions2_function" "github_cdn" {
  name     = var.function_name
  location = var.region

  build_config {
    runtime     = var.runtime
    entry_point = var.entry_point

    source {
      storage_source {
        bucket = google_storage_bucket.source.name
        object = google_storage_bucket_object.source.name
      }
    }
  }

  service_config {
    max_instance_count    = var.max_instance_count
    available_memory      = var.available_memory
    timeout_seconds       = var.timeout_seconds
    service_account_email = google_service_account.runtime.email
    ingress_settings      = "ALLOW_ALL"
  }
}

resource "google_cloud_run_service_iam_member" "invoker" {
  for_each = var.invoker_members

  project  = var.project_id
  location = google_cloudfunctions2_function.github_cdn.location
  service  = google_cloudfunctions2_function.github_cdn.name
  role     = "roles/run.invoker"
  member   = each.value
}
