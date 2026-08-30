package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWithGitHubTokenUsesDedicatedHeader(t *testing.T) {
	var got string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer google-iam-token")
	req.Header.Set(GitHubTokenHeader, "github-token")
	res := httptest.NewRecorder()

	withGitHubToken(next).ServeHTTP(res, req)

	if res.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusNoContent)
	}
	if got != "Bearer github-token" {
		t.Fatalf("Authorization = %q, want dedicated GitHub token", got)
	}
}

func TestWithGitHubTokenDoesNotReuseAuthorization(t *testing.T) {
	var got string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer google-iam-token")
	res := httptest.NewRecorder()

	withGitHubToken(next).ServeHTTP(res, req)

	if got != "" {
		t.Fatalf("Authorization = %q, want empty without %s", got, GitHubTokenHeader)
	}
}
