package hmacsign

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

type Input struct {
	Method     string
	Path       string
	Timestamp  string
	Nonce      string
	BodySHA256 string
	KeyID      string
}

func CanonicalString(input Input) string {
	return strings.Join([]string{
		strings.ToUpper(input.Method),
		input.Path,
		input.Timestamp,
		input.Nonce,
		strings.ToLower(strings.TrimPrefix(input.BodySHA256, "sha256:")),
		input.KeyID,
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
