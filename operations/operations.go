package operations

import (
	"context"
	"fmt"
	"strings"

	"github.com/dash-xd/github-cdn/cdn"
	"github.com/dash-xd/github-cdn/ghservice"
)

// Service is the GitHub capability required by the github-cdn operations.
// HTTP, CLI, and other adapters should depend on these operations rather than
// reimplementing their request normalization or calling transport handlers.
type Service interface {
	CreateRepo(context.Context, string, string, bool) (ghservice.Repo, error)
	CommitObjects(context.Context, string, string, string, []cdn.Object) (ghservice.CommitResult, error)
	Snapshot(context.Context, string, string, string, bool) ([]ghservice.SnapshotEntry, error)
	Delete(context.Context, string, string, string, []string) (ghservice.CommitResult, error)
	CreateEmptyBranch(context.Context, string, string, string) (ghservice.CommitResult, error)
	CreateBranchFrom(context.Context, string, string, string, string) (ghservice.CommitResult, error)
}

func New(token string) (Service, error) { return ghservice.New(token) }

type InvalidArgumentError struct{ Message string }

func (e *InvalidArgumentError) Error() string { return e.Message }

func invalidf(format string, args ...any) error {
	return &InvalidArgumentError{Message: fmt.Sprintf(format, args...)}
}

type CreateRepoRequest struct {
	Owner   string
	Name    string
	Private bool
}

func CreateRepo(ctx context.Context, svc Service, req CreateRepoRequest) (ghservice.Repo, error) {
	if strings.TrimSpace(req.Name) == "" {
		return ghservice.Repo{}, invalidf("repository name is required")
	}
	return svc.CreateRepo(ctx, strings.TrimSpace(req.Owner), req.Name, req.Private)
}

type UploadRequest struct {
	Owner   string
	Repo    string
	Branch  string
	Objects []cdn.Object
}

func Upload(ctx context.Context, svc Service, req UploadRequest) (ghservice.CommitResult, error) {
	if len(req.Objects) == 0 {
		return ghservice.CommitResult{}, invalidf("no files uploaded")
	}
	return svc.CommitObjects(ctx, req.Owner, req.Repo, req.Branch, req.Objects)
}

type SnapshotRequest struct {
	Owner          string
	Repo           string
	Branch         string
	IncludeContent bool
}

func Snapshot(ctx context.Context, svc Service, req SnapshotRequest) ([]ghservice.SnapshotEntry, error) {
	if strings.TrimSpace(req.Branch) == "" {
		return nil, invalidf("branch is required")
	}
	return svc.Snapshot(ctx, req.Owner, req.Repo, req.Branch, req.IncludeContent)
}

type DeleteRequest struct {
	Owner     string
	Repo      string
	Branch    string
	Paths     []string
	ObjectIDs []string
}

func Delete(ctx context.Context, svc Service, req DeleteRequest) (ghservice.CommitResult, error) {
	paths := append([]string{}, req.Paths...)
	for _, id := range req.ObjectIDs {
		path := cdn.ObjectPath(id)
		if path == "" {
			return ghservice.CommitResult{}, invalidf("invalid objectId %q", id)
		}
		paths = append(paths, path)
	}
	if len(paths) == 0 {
		return ghservice.CommitResult{}, invalidf("provide path(s) or objectId(s)")
	}
	if strings.TrimSpace(req.Branch) == "" {
		return ghservice.CommitResult{}, invalidf("branch is required")
	}
	return svc.Delete(ctx, req.Owner, req.Repo, req.Branch, paths)
}

type CreateEmptyBranchRequest struct {
	Owner  string
	Repo   string
	Branch string
}

func CreateEmptyBranch(ctx context.Context, svc Service, req CreateEmptyBranchRequest) (ghservice.CommitResult, error) {
	if strings.TrimSpace(req.Branch) == "" {
		return ghservice.CommitResult{}, invalidf("branch is required")
	}
	return svc.CreateEmptyBranch(ctx, req.Owner, req.Repo, req.Branch)
}

type CreateBranchFromRequest struct {
	Owner  string
	Repo   string
	Branch string
	Source string
}

func CreateBranchFrom(ctx context.Context, svc Service, req CreateBranchFromRequest) (ghservice.CommitResult, error) {
	if strings.TrimSpace(req.Branch) == "" || strings.TrimSpace(req.Source) == "" {
		return ghservice.CommitResult{}, invalidf("branch and source are required")
	}
	return svc.CreateBranchFrom(ctx, req.Owner, req.Repo, req.Branch, req.Source)
}
