package ghservice

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	mrand "math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
	"github.com/dash-xd/github-cdn/cdn"
)

const (
	emptyBranchMarker   = ".github-cdn-empty-tree"
	maxMutationAttempts = 12
	maxRetryDelay       = 100 * time.Millisecond
)

type Service struct {
	rest *api.RESTClient
	gql  *api.GraphQLClient
}

type Repo struct {
	Name          string `json:"name"`
	Owner         string `json:"owner"`
	URL           string `json:"url"`
	DefaultBranch string `json:"default_branch"`
}

type CommitResult struct {
	Repo      string       `json:"repo"`
	Branch    string       `json:"branch"`
	Commit    string       `json:"commit"`
	Objects   []cdn.Object `json:"objects,omitempty"`
	Requested int          `json:"requested,omitempty"`
}

type SnapshotEntry struct {
	Path     string `json:"path"`
	Mode     string `json:"mode"`
	SHA      string `json:"sha"`
	Encoding string `json:"encoding,omitempty"`
	Content  string `json:"content,omitempty"`
}

func New(token string) (*Service, error) {
	opts := api.ClientOptions{AuthToken: token, Host: "github.com", Timeout: 30 * time.Second}
	rest, err := api.NewRESTClient(opts)
	if err != nil {
		return nil, err
	}
	gql, err := api.NewGraphQLClient(opts)
	if err != nil {
		return nil, err
	}
	return &Service{rest: rest, gql: gql}, nil
}

func (s *Service) CreateRepo(ctx context.Context, owner, name string, private bool) (Repo, error) {
	name = sanitizeName(name) + "-" + randomSuffix()
	body, _ := json.Marshal(map[string]any{"name": name, "private": private, "auto_init": true})
	path := "user/repos"
	if owner != "" {
		path = "orgs/" + url.PathEscape(owner) + "/repos"
	}
	var out struct {
		Name          string `json:"name"`
		HTMLURL       string `json:"html_url"`
		DefaultBranch string `json:"default_branch"`
		Owner         struct {
			Login string `json:"login"`
		} `json:"owner"`
	}
	if err := s.rest.DoWithContext(ctx, http.MethodPost, path, bytes.NewReader(body), &out); err != nil {
		return Repo{}, err
	}
	return Repo{Name: out.Name, Owner: out.Owner.Login, URL: out.HTMLURL, DefaultBranch: out.DefaultBranch}, nil
}

func (s *Service) DefaultBranch(ctx context.Context, owner, repo string) (string, error) {
	var out struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := s.rest.DoWithContext(ctx, http.MethodGet, fmt.Sprintf("repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo)), nil, &out); err != nil {
		return "", err
	}
	return out.DefaultBranch, nil
}

func (s *Service) head(ctx context.Context, owner, repo, branch string) (string, error) {
	var out struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	path := fmt.Sprintf("repos/%s/%s/git/ref/heads/%s", url.PathEscape(owner), url.PathEscape(repo), escapeRef(branch))
	if err := s.rest.DoWithContext(ctx, http.MethodGet, path, nil, &out); err != nil {
		return "", err
	}
	return out.Object.SHA, nil
}

func (s *Service) CommitObjects(ctx context.Context, owner, repo, branch string, objects []cdn.Object) (CommitResult, error) {
	if len(objects) == 0 {
		return CommitResult{}, errors.New("no files to upload")
	}
	if branch == "" {
		var err error
		branch, err = s.DefaultBranch(ctx, owner, repo)
		if err != nil {
			return CommitResult{}, err
		}
	}
	seen := map[string]bool{}
	adds := make([]map[string]any, 0, len(objects))
	for _, object := range objects {
		if object.Path == "" || seen[object.ObjectID] {
			continue
		}
		seen[object.ObjectID] = true
		adds = append(adds, map[string]any{"path": object.Path, "contents": base64.StdEncoding.EncodeToString(object.Content)})
	}
	commit, err := s.mutate(ctx, owner, repo, branch, fmt.Sprintf("store %d object(s)", len(adds)), adds, nil)
	if err != nil {
		return CommitResult{}, err
	}
	return CommitResult{Repo: repo, Branch: branch, Commit: commit, Objects: objects}, nil
}

func (s *Service) Delete(ctx context.Context, owner, repo, branch string, paths []string) (CommitResult, error) {
	uniq := map[string]bool{}
	dels := make([]map[string]any, 0, len(paths))
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" || uniq[path] {
			continue
		}
		uniq[path] = true
		dels = append(dels, map[string]any{"path": path})
	}
	if len(dels) == 0 {
		return CommitResult{}, errors.New("no paths to delete")
	}
	commit, err := s.mutate(ctx, owner, repo, branch, fmt.Sprintf("delete %d object(s)", len(dels)), nil, dels)
	if err != nil {
		return CommitResult{}, err
	}
	return CommitResult{Repo: repo, Branch: branch, Commit: commit, Requested: len(dels)}, nil
}

func (s *Service) mutate(ctx context.Context, owner, repo, branch, message string, additions, deletions []map[string]any) (string, error) {
	const mutation = `mutation($input: CreateCommitOnBranchInput!) {
		createCommitOnBranch(input: $input) { commit { oid } }
	}`
	var last error
	for attempt := 1; attempt <= maxMutationAttempts; attempt++ {
		head, err := s.head(ctx, owner, repo, branch)
		if err != nil {
			return "", err
		}
		changes := map[string]any{}
		if len(additions) > 0 {
			changes["additions"] = additions
		}
		if len(deletions) > 0 {
			changes["deletions"] = deletions
		}
		input := map[string]any{
			"branch":          map[string]any{"repositoryNameWithOwner": owner + "/" + repo, "branchName": branch},
			"expectedHeadOid": head,
			"message":         map[string]any{"headline": message},
			"fileChanges":     changes,
		}
		var out struct {
			CreateCommitOnBranch struct {
				Commit struct {
					OID string `json:"oid"`
				} `json:"commit"`
			} `json:"createCommitOnBranch"`
		}
		err = s.gql.DoWithContext(ctx, mutation, map[string]any{"input": input}, &out)
		if err == nil {
			return out.CreateCommitOnBranch.Commit.OID, nil
		}
		last = err
		if !isStale(err) || attempt == maxMutationAttempts {
			return "", err
		}
		ceiling := min(maxRetryDelay, time.Duration(1<<(attempt-1))*time.Millisecond)
		jitter := time.Duration(mrand.Int64N(int64(ceiling) + 1))
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(jitter):
		}
	}
	return "", last
}

func isStale(err error) bool {
	var gqlErr *api.GraphQLError
	if errors.As(err, &gqlErr) {
		for _, item := range gqlErr.Errors {
			if item.Type == "STALE_DATA" || strings.Contains(strings.ToLower(item.Message), "expected branch to point") {
				return true
			}
		}
	}
	return false
}

func (s *Service) Snapshot(ctx context.Context, owner, repo, branch string, includeContent bool) ([]SnapshotEntry, error) {
	var ref struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	refPath := fmt.Sprintf("repos/%s/%s/git/ref/heads/%s", url.PathEscape(owner), url.PathEscape(repo), escapeRef(branch))
	if err := s.rest.DoWithContext(ctx, http.MethodGet, refPath, nil, &ref); err != nil {
		return nil, err
	}
	var commit struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	commitPath := fmt.Sprintf("repos/%s/%s/git/commits/%s", url.PathEscape(owner), url.PathEscape(repo), ref.Object.SHA)
	if err := s.rest.DoWithContext(ctx, http.MethodGet, commitPath, nil, &commit); err != nil {
		return nil, err
	}
	var tree struct {
		Tree      []struct{ Path, Mode, Type, SHA string } `json:"tree"`
		Truncated bool                                     `json:"truncated"`
	}
	treePath := fmt.Sprintf("repos/%s/%s/git/trees/%s?recursive=1", url.PathEscape(owner), url.PathEscape(repo), commit.Tree.SHA)
	if err := s.rest.DoWithContext(ctx, http.MethodGet, treePath, nil, &tree); err != nil {
		return nil, err
	}
	if tree.Truncated {
		return nil, statusError(413, "branch tree exceeds GitHub's recursive tree response limit")
	}
	out := make([]SnapshotEntry, 0, len(tree.Tree))
	for _, entry := range tree.Tree {
		if entry.Type != "blob" || entry.Path == emptyBranchMarker {
			continue
		}
		item := SnapshotEntry{Path: entry.Path, Mode: entry.Mode, SHA: entry.SHA}
		if includeContent {
			var blob struct{ Encoding, Content string }
			blobPath := fmt.Sprintf("repos/%s/%s/git/blobs/%s", url.PathEscape(owner), url.PathEscape(repo), entry.SHA)
			if err := s.rest.DoWithContext(ctx, http.MethodGet, blobPath, nil, &blob); err != nil {
				return nil, err
			}
			item.Encoding, item.Content = blob.Encoding, blob.Content
		}
		out = append(out, item)
	}
	return out, nil
}

func (s *Service) CreateEmptyBranch(ctx context.Context, owner, repo, branch string) (CommitResult, error) {
	blobBody, _ := json.Marshal(map[string]any{"content": "", "encoding": "utf-8"})
	var blob struct {
		SHA string `json:"sha"`
	}
	base := fmt.Sprintf("repos/%s/%s/git", url.PathEscape(owner), url.PathEscape(repo))
	if err := s.rest.DoWithContext(ctx, http.MethodPost, base+"/blobs", bytes.NewReader(blobBody), &blob); err != nil {
		return CommitResult{}, err
	}
	treeBody, _ := json.Marshal(map[string]any{"tree": []map[string]any{{"path": emptyBranchMarker, "mode": "100644", "type": "blob", "sha": blob.SHA}}})
	var tree struct {
		SHA string `json:"sha"`
	}
	if err := s.rest.DoWithContext(ctx, http.MethodPost, base+"/trees", bytes.NewReader(treeBody), &tree); err != nil {
		return CommitResult{}, err
	}
	commitBody, _ := json.Marshal(map[string]any{"message": "initialize empty branch", "tree": tree.SHA, "parents": []string{}})
	var commit struct {
		SHA string `json:"sha"`
	}
	if err := s.rest.DoWithContext(ctx, http.MethodPost, base+"/commits", bytes.NewReader(commitBody), &commit); err != nil {
		return CommitResult{}, err
	}
	refBody, _ := json.Marshal(map[string]any{"ref": "refs/heads/" + branch, "sha": commit.SHA})
	if err := s.rest.DoWithContext(ctx, http.MethodPost, base+"/refs", bytes.NewReader(refBody), &struct{}{}); err != nil {
		return CommitResult{}, err
	}
	return CommitResult{Repo: repo, Branch: branch, Commit: commit.SHA}, nil
}

func (s *Service) CreateBranchFrom(ctx context.Context, owner, repo, branch, source string) (CommitResult, error) {
	head, err := s.head(ctx, owner, repo, source)
	if err != nil {
		return CommitResult{}, err
	}
	body, _ := json.Marshal(map[string]any{"ref": "refs/heads/" + branch, "sha": head})
	path := fmt.Sprintf("repos/%s/%s/git/refs", url.PathEscape(owner), url.PathEscape(repo))
	if err := s.rest.DoWithContext(ctx, http.MethodPost, path, bytes.NewReader(body), &struct{}{}); err != nil {
		return CommitResult{}, err
	}
	return CommitResult{Repo: repo, Branch: branch, Commit: head}, nil
}

func sanitizeName(name string) string {
	name = strings.TrimSpace(name)
	var b strings.Builder
	lastDash := false
	for _, r := range name {
		ok := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-'
		if ok {
			b.WriteRune(r)
			lastDash = false
		} else if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	cleaned := strings.Trim(b.String(), "-")
	if cleaned == "" {
		return "repo"
	}
	return cleaned
}

func randomSuffix() string {
	var buf [4]byte
	if _, err := crand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%08x", time.Now().UnixNano())[:8]
	}
	return hex.EncodeToString(buf[:])
}

func escapeRef(branch string) string { return strings.ReplaceAll(url.PathEscape(branch), "%2F", "/") }

type StatusError struct {
	Status  int
	Message string
}

func (e *StatusError) Error() string { return e.Message }
func statusError(status int, message string) error {
	return &StatusError{Status: status, Message: message}
}

func HTTPStatus(err error) int {
	var statusErr *StatusError
	if errors.As(err, &statusErr) {
		return statusErr.Status
	}
	var httpErr *api.HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode
	}
	return http.StatusInternalServerError
}
