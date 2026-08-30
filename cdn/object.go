package cdn

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

const ObjectPrefix = "objects"

type Object struct {
	ObjectID     string `json:"objectId"`
	Path         string `json:"path"`
	OriginalName string `json:"name,omitempty"`
	ContentType  string `json:"contentType,omitempty"`
	Size         int64  `json:"size"`
	Content      []byte `json:"-"`
}

func NewObject(name, contentType string, content []byte) Object {
	sum := sha256.Sum256(content)
	id := hex.EncodeToString(sum[:])
	return Object{
		ObjectID:     id,
		Path:         ObjectPath(id),
		OriginalName: name,
		ContentType:  contentType,
		Size:         int64(len(content)),
		Content:      content,
	}
}

func ObjectPath(objectID string) string {
	objectID = strings.ToLower(strings.TrimSpace(objectID))
	if len(objectID) != 64 {
		return ""
	}
	if _, err := hex.DecodeString(objectID); err != nil {
		return ""
	}
	return fmt.Sprintf("%s/%s/%s", ObjectPrefix, objectID[:2], objectID)
}
