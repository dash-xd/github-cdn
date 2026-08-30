// Package function exposes the HTTP entry point discovered by the Go
// Cloud Functions Gen2 buildpack. The router itself is ordinary net/http;
// no local Functions Framework dependency is required.
package function

import (
	"net/http"

	"github.com/dash-xd/github-cdn/app"
)

var Main func(http.ResponseWriter, *http.Request) = app.Handler().ServeHTTP
