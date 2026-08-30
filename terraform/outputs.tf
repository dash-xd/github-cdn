output "function_name" {
  value = google_cloudfunctions2_function.github_cdn.name
}

output "function_uri" {
  value = google_cloudfunctions2_function.github_cdn.service_config[0].uri
}

output "region" {
  value = google_cloudfunctions2_function.github_cdn.location
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "source_bucket" {
  value = google_storage_bucket.source.name
}
