package router

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/dash-xd/github-cdn/cdn"
	"github.com/dash-xd/github-cdn/ghservice"
	"github.com/go-chi/chi/v5"
)

type Service interface {
	CreateRepo(context.Context, string, string, bool) (ghservice.Repo, error)
	CommitObjects(context.Context, string, string, string, []cdn.Object) (ghservice.CommitResult, error)
	Snapshot(context.Context, string, string, string, bool) ([]ghservice.SnapshotEntry, error)
	Delete(context.Context, string, string, string, []string) (ghservice.CommitResult, error)
	CreateEmptyBranch(context.Context, string, string, string) (ghservice.CommitResult, error)
	CreateBranchFrom(context.Context, string, string, string, string) (ghservice.CommitResult, error)
}

type Factory func(token string) (Service, error)

type serviceKey struct{}

func New() http.Handler {
	return NewWithFactory(func(token string) (Service, error) { return ghservice.New(token) })
}

func NewWithFactory(factory Factory) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "ok", "url": r.URL.RequestURI()})
	})
	r.Get("/docs", docsPage)
	r.Get("/docs/", docsPage)
	r.Get("/docs/openapi.json", openAPIDocument)
	r.Route("/github", func(r chi.Router) {
		r.Use(auth(factory))
		r.Post("/repos/{name}", createRepo(false))
		r.Post("/repos/{org}/{name}", createRepo(true))
		r.Post("/repos/{owner}/{repo}/upload", upload)
		r.Post("/repos/{owner}/{repo}/branches", emptyBranch)
		r.Post("/repos/{owner}/{repo}/branches/from", branchFrom)
		r.Get("/repos/{owner}/{repo}/*", snapshot)
		r.Delete("/repos/{owner}/{repo}/*", deleteObjects)
	})
	return r
}

func auth(factory Factory) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth := strings.TrimSpace(r.Header.Get("Authorization"))
			if !strings.HasPrefix(strings.ToLower(auth), "bearer ") {
				writeJSON(w, 401, map[string]string{"error": "Bearer token required"})
				return
			}
			token := strings.TrimSpace(auth[len("Bearer "):])
			if token == "" {
				writeJSON(w, 401, map[string]string{"error": "Bearer token required"})
				return
			}
			svc, err := factory(token)
			if err != nil {
				writeError(w, err)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), serviceKey{}, svc)))
		})
	}
}

func svc(r *http.Request) Service { return r.Context().Value(serviceKey{}).(Service) }

func createRepo(org bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Private *bool `json:"private"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		private := true
		if body.Private != nil {
			private = *body.Private
		}
		owner := ""
		if org {
			owner = chi.URLParam(r, "org")
		}
		res, err := svc(r).CreateRepo(r.Context(), owner, chi.URLParam(r, "name"), private)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 201, res)
	}
}

func upload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	branch := r.URL.Query().Get("branch")
	if branch == "" {
		branch = r.FormValue("branch")
	}
	objects := []cdn.Object{}
	for _, headers := range r.MultipartForm.File {
		for _, header := range headers {
			f, err := header.Open()
			if err != nil {
				writeError(w, err)
				return
			}
			content, err := io.ReadAll(io.LimitReader(f, (25<<20)+1))
			f.Close()
			if err != nil {
				writeError(w, err)
				return
			}
			if len(content) > 25<<20 {
				writeJSON(w, 413, map[string]string{"error": "file exceeds 25 MiB limit"})
				return
			}
			objects = append(objects, cdn.NewObject(header.Filename, header.Header.Get("Content-Type"), content))
		}
	}
	if len(objects) == 0 {
		writeJSON(w, 400, map[string]string{"error": "no files uploaded"})
		return
	}
	res, err := svc(r).CommitObjects(r.Context(), chi.URLParam(r, "owner"), chi.URLParam(r, "repo"), branch, objects)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, res)
}

func snapshot(w http.ResponseWriter, r *http.Request) {
	content, _ := strconv.ParseBool(r.URL.Query().Get("content"))
	res, err := svc(r).Snapshot(r.Context(), chi.URLParam(r, "owner"), chi.URLParam(r, "repo"), chi.URLParam(r, "*"), content)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, res)
}

func deleteObjects(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path      string   `json:"path"`
		Paths     []string `json:"paths"`
		ObjectID  string   `json:"objectId"`
		ObjectIDs []string `json:"objectIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid JSON"})
		return
	}
	paths := append([]string{}, body.Paths...)
	if body.Path != "" {
		paths = append(paths, body.Path)
	}
	ids := append([]string{}, body.ObjectIDs...)
	if body.ObjectID != "" {
		ids = append(ids, body.ObjectID)
	}
	for _, id := range ids {
		if p := cdn.ObjectPath(id); p != "" {
			paths = append(paths, p)
		} else {
			writeJSON(w, 400, map[string]string{"error": fmt.Sprintf("invalid objectId %q", id)})
			return
		}
	}
	if len(paths) == 0 {
		writeJSON(w, 400, map[string]string{"error": "provide path(s) or objectId(s)"})
		return
	}
	res, err := svc(r).Delete(r.Context(), chi.URLParam(r, "owner"), chi.URLParam(r, "repo"), chi.URLParam(r, "*"), paths)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, res)
}

func emptyBranch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Branch string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Branch == "" {
		writeJSON(w, 400, map[string]string{"error": "branch is required"})
		return
	}
	res, err := svc(r).CreateEmptyBranch(r.Context(), chi.URLParam(r, "owner"), chi.URLParam(r, "repo"), body.Branch)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 201, res)
}

func branchFrom(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Branch string `json:"branch"`
		Source string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Branch == "" || body.Source == "" {
		writeJSON(w, 400, map[string]string{"error": "branch and source are required"})
		return
	}
	res, err := svc(r).CreateBranchFrom(r.Context(), chi.URLParam(r, "owner"), chi.URLParam(r, "repo"), body.Branch, body.Source)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 201, res)
}

func writeError(w http.ResponseWriter, err error) {
	status := ghservice.HTTPStatus(err)
	var se *ghservice.StatusError
	if errors.As(err, &se) {
		status = se.Status
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
