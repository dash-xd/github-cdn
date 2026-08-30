package ghservice

import (
	"errors"
	"testing"
)

func TestOptimisticConflictMessages(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"actual stale head wording", errors.New("GraphQL: is at 6b1940b but expected 68d1163 (createCommitOnBranch)"), true},
		{"transient branch resolution", errors.New("GraphQL: Branch not found (createCommitOnBranch)"), true},
		{"legacy stale wording", errors.New("expected branch to point at another oid"), true},
		{"ordinary error", errors.New("GraphQL: repository not found"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isOptimisticConflict(tt.err); got != tt.want {
				t.Fatalf("isOptimisticConflict() = %v, want %v", got, tt.want)
			}
		})
	}
}
