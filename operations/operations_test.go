package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/dash-xd/github-cdn/cdn"
	"github.com/dash-xd/github-cdn/ghservice"
)

type fakeService struct {
	deletePaths []string
	deleteBranch string
	uploadObjects []cdn.Object
}

func (f *fakeService) CreateRepo(context.Context, string, string, bool) (ghservice.Repo, error) {
	return ghservice.Repo{Name: "repo"}, nil
}
func (f *fakeService) CommitObjects(_ context.Context, _, _, _ string, objects []cdn.Object) (ghservice.CommitResult, error) {
	f.uploadObjects = objects
	return ghservice.CommitResult{Commit: "upload"}, nil
}
func (f *fakeService) Snapshot(context.Context, string, string, string, bool) ([]ghservice.SnapshotEntry, error) {
	return []ghservice.SnapshotEntry{{Path: "a"}}, nil
}
func (f *fakeService) Delete(_ context.Context, _, _, branch string, paths []string) (ghservice.CommitResult, error) {
	f.deleteBranch = branch
	f.deletePaths = append([]string{}, paths...)
	return ghservice.CommitResult{Commit: "delete"}, nil
}
func (f *fakeService) CreateEmptyBranch(context.Context, string, string, string) (ghservice.CommitResult, error) {
	return ghservice.CommitResult{Commit: "empty"}, nil
}
func (f *fakeService) CreateBranchFrom(context.Context, string, string, string, string) (ghservice.CommitResult, error) {
	return ghservice.CommitResult{Commit: "from"}, nil
}

func TestDeleteConvertsObjectIDs(t *testing.T) {
	f := &fakeService{}
	id := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	_, err := Delete(context.Background(), f, DeleteRequest{
		Owner: "o", Repo: "r", Branch: "main", Paths: []string{"manual"}, ObjectIDs: []string{id},
	})
	if err != nil {
		t.Fatal(err)
	}
	if f.deleteBranch != "main" {
		t.Fatalf("branch = %q", f.deleteBranch)
	}
	want := []string{"manual", cdn.ObjectPath(id)}
	if len(f.deletePaths) != len(want) {
		t.Fatalf("paths = %#v", f.deletePaths)
	}
	for i := range want {
		if f.deletePaths[i] != want[i] {
			t.Fatalf("paths = %#v, want %#v", f.deletePaths, want)
		}
	}
}

func TestDeleteRejectsInvalidObjectIDBeforeService(t *testing.T) {
	f := &fakeService{}
	_, err := Delete(context.Background(), f, DeleteRequest{Owner: "o", Repo: "r", Branch: "main", ObjectIDs: []string{"bad"}})
	var invalid *InvalidArgumentError
	if !errors.As(err, &invalid) {
		t.Fatalf("error = %v, want InvalidArgumentError", err)
	}
	if len(f.deletePaths) != 0 {
		t.Fatalf("service called with %#v", f.deletePaths)
	}
}

func TestUploadRejectsEmptyObjects(t *testing.T) {
	_, err := Upload(context.Background(), &fakeService{}, UploadRequest{Owner: "o", Repo: "r"})
	var invalid *InvalidArgumentError
	if !errors.As(err, &invalid) {
		t.Fatalf("error = %v, want InvalidArgumentError", err)
	}
}

func TestBranchValidationIsShared(t *testing.T) {
	f := &fakeService{}
	if _, err := CreateEmptyBranch(context.Background(), f, CreateEmptyBranchRequest{Owner: "o", Repo: "r"}); err == nil {
		t.Fatal("expected empty branch validation error")
	}
	if _, err := CreateBranchFrom(context.Background(), f, CreateBranchFromRequest{Owner: "o", Repo: "r", Branch: "new"}); err == nil {
		t.Fatal("expected source validation error")
	}
}
