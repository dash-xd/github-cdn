package app

import (
	"net/http"
	"strings"

	"github.com/dash-xd/github-cdn/router"
)

const GitHubTokenHeader = "X-GH-Device-Access-Token"

func Handler() http.Handler {
	return withGitHubToken(router.New())
}

func withGitHubToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clone := r.Clone(r.Context())
		clone.Header = r.Header.Clone()
		clone.Header.Del("Authorization")

		if token := strings.TrimSpace(r.Header.Get(GitHubTokenHeader)); token != "" {
			clone.Header.Set("Authorization", "Bearer "+token)
		}

		next.ServeHTTP(w, clone)
	})
}
