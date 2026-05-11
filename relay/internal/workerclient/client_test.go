package workerclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alexlmiller/cf-mail-relay/relay/internal/hmacsign"
)

func TestClientSignsAuthRequest(t *testing.T) {
	client := &Client{
		KeyID:   "rel_test",
		Secret:  "secret",
		Version: "0.1.0-test",
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/relay/auth" {
			t.Fatalf("path = %s", got)
		}
		body := []byte(`{"username":"gmail","password":"pw"}`)
		if got := r.Header.Get("X-Relay-Body-SHA256"); got != hmacsign.SHA256Hex(body) {
			t.Fatalf("body hash = %s", got)
		}
		input := hmacsign.Input{
			Method:     r.Method,
			Path:       r.URL.Path,
			Timestamp:  r.Header.Get("X-Relay-Timestamp"),
			Nonce:      r.Header.Get("X-Relay-Nonce"),
			BodySHA256: r.Header.Get("X-Relay-Body-SHA256"),
			KeyID:      r.Header.Get("X-Relay-Key-Id"),
		}
		if ts, err := time.ParseDuration(r.Header.Get("X-Relay-Timestamp") + "s"); err != nil || ts <= 0 {
			t.Fatalf("bad timestamp")
		}
		if got, want := r.Header.Get("X-Relay-Signature"), hmacsign.Sign(input, "secret"); got != want {
			t.Fatalf("signature = %s want %s", got, want)
		}
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(AuthResponse{OK: true, TTLSeconds: 60})
	}))
	defer server.Close()
	client.BaseURL = server.URL

	response, err := client.Auth(context.Background(), "gmail", "pw")
	if err != nil {
		t.Fatal(err)
	}
	if !response.OK {
		t.Fatalf("response not ok")
	}
}

func TestClientSendsEnvelopeHeaders(t *testing.T) {
	client := &Client{KeyID: "rel_test", Secret: "secret", Version: "0.1.0-test"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Relay-Envelope-From"); got != "gmail@alexmiller.net" {
			t.Fatalf("envelope from = %s", got)
		}
		if got := r.Header.Get("X-Relay-Recipients"); got != "one@example.net,two@example.net" {
			t.Fatalf("recipients = %s", got)
		}
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "message/rfc822") {
			t.Fatalf("content-type = %s", ct)
		}
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(SendResponse{OK: true, CFStatus: 200})
	}))
	defer server.Close()
	client.BaseURL = server.URL

	_, err := client.Send(context.Background(), "gmail@alexmiller.net", []string{"one@example.net", "two@example.net"}, []byte("From: x\r\n\r\nBody\r\n"))
	if err != nil {
		t.Fatal(err)
	}
}
