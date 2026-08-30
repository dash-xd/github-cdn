package router

import "net/http"

const openAPI = `{
  "openapi": "3.0.3",
  "info": {
    "title": "GitHub CDN Go Router",
    "version": "0.1.0",
    "description": "Token-only content-addressed GitHub CDN router backed by the gh Go client stack."
  },
  "components": {
    "securitySchemes": {
      "bearerAuth": {"type": "http", "scheme": "bearer"}
    }
  },
  "security": [{"bearerAuth": []}],
  "paths": {
    "/github/repos/{name}": {"post": {"summary": "Create a repository for the authenticated user"}},
    "/github/repos/{org}/{name}": {"post": {"summary": "Create an organization repository"}},
    "/github/repos/{owner}/{repo}/upload": {"post": {"summary": "Upload content-addressed objects"}},
    "/github/repos/{owner}/{repo}/{branch}": {
      "get": {"summary": "Read a branch snapshot"},
      "delete": {"summary": "Delete paths or object IDs from a branch"}
    },
    "/github/repos/{owner}/{repo}/branches": {"post": {"summary": "Create an empty orphan branch"}},
    "/github/repos/{owner}/{repo}/branches/from": {"post": {"summary": "Create a branch from another branch"}}
  }
}`

func docsPage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(`<!doctype html><html><head><meta charset="utf-8"><title>GitHub CDN Go Router</title></head><body><h1>GitHub CDN Go Router</h1><p>Token-only GitHub CDN API.</p><p><a href="/docs/openapi.json">OpenAPI document</a></p></body></html>`))
}

func openAPIDocument(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(openAPI))
}
