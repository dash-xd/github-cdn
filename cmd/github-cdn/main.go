package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/dash-xd/github-cdn/cdn"
	"github.com/dash-xd/github-cdn/operations"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "github-cdn:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return usageError()
	}
	token := strings.TrimSpace(os.Getenv("GH_TOKEN"))
	if token == "" {
		token = strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
	}
	if token == "" {
		return errors.New("GH_TOKEN or GITHUB_TOKEN is required")
	}
	svc, err := operations.New(token)
	if err != nil {
		return err
	}

	var out any
	switch args[0] {
	case "repo-create":
		fs := flag.NewFlagSet("repo-create", flag.ContinueOnError)
		owner := fs.String("owner", "", "organization owner; empty creates under the authenticated user")
		private := fs.Bool("private", true, "create a private repository")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if fs.NArg() != 1 {
			return errors.New("usage: github-cdn repo-create [--owner ORG] [--private=true|false] NAME")
		}
		out, err = operations.CreateRepo(ctx, svc, operations.CreateRepoRequest{Owner: *owner, Name: fs.Arg(0), Private: *private})

	case "upload":
		fs := flag.NewFlagSet("upload", flag.ContinueOnError)
		branch := fs.String("branch", "", "target branch; empty uses the repository default branch")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if fs.NArg() < 3 {
			return errors.New("usage: github-cdn upload [--branch BRANCH] OWNER REPO FILE [FILE...]")
		}
		objects := make([]cdn.Object, 0, fs.NArg()-2)
		for _, path := range fs.Args()[2:] {
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if len(body) > 25<<20 {
				return fmt.Errorf("%s exceeds 25 MiB limit", path)
			}
			contentType := mime.TypeByExtension(filepath.Ext(path))
			objects = append(objects, cdn.NewObject(filepath.Base(path), contentType, body))
		}
		out, err = operations.Upload(ctx, svc, operations.UploadRequest{Owner: fs.Arg(0), Repo: fs.Arg(1), Branch: *branch, Objects: objects})

	case "snapshot":
		fs := flag.NewFlagSet("snapshot", flag.ContinueOnError)
		content := fs.Bool("content", false, "include blob content")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if fs.NArg() != 3 {
			return errors.New("usage: github-cdn snapshot [--content] OWNER REPO BRANCH")
		}
		out, err = operations.Snapshot(ctx, svc, operations.SnapshotRequest{Owner: fs.Arg(0), Repo: fs.Arg(1), Branch: fs.Arg(2), IncludeContent: *content})

	case "delete":
		fs := flag.NewFlagSet("delete", flag.ContinueOnError)
		var paths, objectIDs stringsFlag
		fs.Var(&paths, "path", "path to delete; repeatable")
		fs.Var(&objectIDs, "object-id", "object ID to delete; repeatable")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if fs.NArg() != 3 {
			return errors.New("usage: github-cdn delete [--path PATH] [--object-id ID] OWNER REPO BRANCH")
		}
		out, err = operations.Delete(ctx, svc, operations.DeleteRequest{Owner: fs.Arg(0), Repo: fs.Arg(1), Branch: fs.Arg(2), Paths: paths, ObjectIDs: objectIDs})

	case "branch-empty":
		if len(args) != 4 {
			return errors.New("usage: github-cdn branch-empty OWNER REPO BRANCH")
		}
		out, err = operations.CreateEmptyBranch(ctx, svc, operations.CreateEmptyBranchRequest{Owner: args[1], Repo: args[2], Branch: args[3]})

	case "branch-from":
		if len(args) != 5 {
			return errors.New("usage: github-cdn branch-from OWNER REPO BRANCH SOURCE")
		}
		out, err = operations.CreateBranchFrom(ctx, svc, operations.CreateBranchFromRequest{Owner: args[1], Repo: args[2], Branch: args[3], Source: args[4]})

	default:
		return usageError()
	}
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

type stringsFlag []string

func (s *stringsFlag) String() string { return strings.Join(*s, ",") }
func (s *stringsFlag) Set(value string) error {
	*s = append(*s, value)
	return nil
}

func usageError() error {
	return errors.New("usage: github-cdn <repo-create|upload|snapshot|delete|branch-empty|branch-from> ...")
}
