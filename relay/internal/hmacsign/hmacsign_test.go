package hmacsign

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type vectorFile struct {
	Vectors []vector `json:"vectors"`
}

type vector struct {
	Name       string `json:"name"`
	Secret     string `json:"secret"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
	Nonce      string `json:"nonce"`
	BodySHA256 string `json:"body_sha256"`
	KeyID      string `json:"key_id"`
	Headers    map[string]string `json:"headers"`
	Canonical  string `json:"canonical"`
	Signature  string `json:"signature"`
}

func TestVectors(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "shared", "test-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var vectors vectorFile
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			input := Input{
				Method:     vector.Method,
				Path:       vector.Path,
				Timestamp:  vector.Timestamp,
				Nonce:      vector.Nonce,
				BodySHA256: vector.BodySHA256,
				KeyID:      vector.KeyID,
				Headers:    vector.Headers,
			}
			if got := CanonicalString(input); got != vector.Canonical {
				t.Fatalf("canonical mismatch:\nwant %q\n got %q", vector.Canonical, got)
			}
			if got := Sign(input, vector.Secret); got != vector.Signature {
				t.Fatalf("signature mismatch: want %s got %s", vector.Signature, got)
			}
		})
	}
}
