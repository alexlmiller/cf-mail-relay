package main

import (
	"encoding/base64"
	"testing"
)

func TestSplitCommand(t *testing.T) {
	cmd, arg := splitCommand("mail from:<sender@example.com> SIZE=123")
	if cmd != "MAIL" {
		t.Fatalf("cmd = %q, want MAIL", cmd)
	}
	if arg != "from:<sender@example.com> SIZE=123" {
		t.Fatalf("arg = %q", arg)
	}
}

func TestParseAuthPlain(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("\x00ms0-capture\x00secret"))
	username, password, err := parseAuthPlain(payload)
	if err != nil {
		t.Fatalf("parseAuthPlain returned error: %v", err)
	}
	if username != "ms0-capture" {
		t.Fatalf("username = %q", username)
	}
	if password != "secret" {
		t.Fatalf("password = %q", password)
	}
}
