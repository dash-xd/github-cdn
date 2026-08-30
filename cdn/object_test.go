package cdn

import "testing"

func TestNewObjectUsesRawSHA256(t *testing.T) {
	object := NewObject("hello.txt", "text/plain", []byte("hello"))
	const want = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	if object.ObjectID != want {
		t.Fatalf("object id = %q, want %q", object.ObjectID, want)
	}
	if object.Path != "objects/2c/"+want {
		t.Fatalf("path = %q", object.Path)
	}
}

func TestObjectPathRejectsInvalidIDs(t *testing.T) {
	for _, id := range []string{"", "abc", "zz" + string(make([]byte, 62))} {
		if got := ObjectPath(id); got != "" {
			t.Fatalf("ObjectPath(%q) = %q, want empty", id, got)
		}
	}
}
