variable "project_id" {
  type        = string
  description = "Google Cloud project in which to deploy."
}

variable "region" {
  type        = string
  description = "Google Cloud region for the function and source bucket."
  default     = "us-west1"
}

variable "function_name" {
  type        = string
  description = "Cloud Run function name."
  default     = "github-cdn"
}

variable "source_dir" {
  type        = string
  description = "Path, relative to terraform/, to the composed implementation source."
  default     = "../.composition/javascript"
}

variable "runtime" {
  type        = string
  description = "Cloud Run functions runtime ID, such as nodejs24 or go126."
  default     = "nodejs24"
}

variable "entry_point" {
  type        = string
  description = "Functions Framework entry point."
  default     = "Main"
}

variable "invoker_members" {
  type        = set(string)
  description = "IAM members allowed to invoke the private function. Empty leaves no explicit invokers."
  default     = []
}

variable "max_instance_count" {
  type    = number
  default = 3
}

variable "available_memory" {
  type    = string
  default = "256M"
}

variable "timeout_seconds" {
  type    = number
  default = 60
}
