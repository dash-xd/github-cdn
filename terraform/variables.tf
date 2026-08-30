variable "project_id" {
  description = "Google Cloud project in which to deploy."
  type        = string
}

variable "region" {
  description = "Google Cloud region for the function and source bucket."
  type        = string
  default     = "us-central1"
}

variable "function_name" {
  description = "Cloud Run function name."
  type        = string
  default     = "github-cdn"
}

variable "invoker_members" {
  description = "IAM members allowed to invoke the private function, for example serviceAccount:caller@example.iam.gserviceaccount.com. Empty keeps the function private with no explicit invokers."
  type        = set(string)
  default     = []
}

variable "runtime" {
  description = "Cloud Run functions runtime."
  type        = string
  default     = "nodejs22"
}

variable "entry_point" {
  description = "Functions Framework entry point."
  type        = string
  default     = "Main"
}

variable "max_instance_count" {
  description = "Maximum function instances."
  type        = number
  default     = 3
}

variable "timeout_seconds" {
  description = "Request timeout."
  type        = number
  default     = 60
}
