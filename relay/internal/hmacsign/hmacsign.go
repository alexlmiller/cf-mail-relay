package hmacsign

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"sort"
	"strings"
)

type Input struct {
	Method     string
	Path       string
	Timestamp  string
	Nonce      string
	BodySHA256 string
	KeyID      string
	Headers    map[string]string
}

func CanonicalString(input Input) string {
	names, values := canonicalHeaders(input.Headers)
	return strings.Join([]string{
		strings.ToUpper(input.Method),
		input.Path,
		input.Timestamp,
		input.Nonce,
		strings.ToLower(strings.TrimPrefix(input.BodySHA256, "sha256:")),
		input.KeyID,
		names,
		values,
	}, "\n")
}

func Sign(input Input, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(CanonicalString(input)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func SHA256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func SignedHeaderNames(headers map[string]string) string {
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, strings.ToLower(name))
	}
	sort.Strings(names)
	return strings.Join(names, ";")
}

func canonicalHeaders(headers map[string]string) (string, string) {
	names := make([]string, 0, len(headers))
	normalized := make(map[string]string, len(headers))
	for name, value := range headers {
		lower := strings.ToLower(name)
		names = append(names, lower)
		normalized[lower] = normalizeHeaderValue(value)
	}
	sort.Strings(names)
	lines := make([]string, 0, len(names))
	for _, name := range names {
		lines = append(lines, name+":"+normalized[name])
	}
	return strings.Join(names, ";"), strings.Join(lines, "\n")
}

func normalizeHeaderValue(value string) string {
	return strings.Join(strings.Fields(value), " ")
}
