package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"testing"
	"time"

	"github.com/alexlmiller/cf-mail-relay/relay/internal/workerclient"
	"github.com/emersion/go-smtp"
)

// Exercise the upgraded SMTP parser against a loopback-only fixture. No DATA
// command is sent, and the mock Worker cannot deliver mail.
func TestSMTPProtocolCompatibility(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/relay/auth" {
			t.Errorf("unexpected Worker request: %s", r.URL.Path)
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(workerclient.AuthResponse{OK: true, AllowedSenders: []string{"fixture@example.invalid"}})
	}))
	defer worker.Close()
	certPath := writeTestCertificateBundle(t, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), "relay.test")
	cert, err := tls.LoadX509KeyPair(certPath, certPath)
	if err != nil {
		t.Fatal(err)
	}
	server := smtp.NewServer(&backend{
		client:          &workerclient.Client{BaseURL: worker.URL, KeyID: "fixture", Secret: "fixture-only", Version: protocolVersion, HTTPClient: worker.Client()},
		maxMessageBytes: 1024,
		throttle:        newThrottle(60, 20, time.Second),
	})
	server.Domain = "relay.test"
	server.AllowInsecureAuth = false
	server.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	defer func() { _ = server.Close(); <-done }()
	conn, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	wire := textproto.NewConn(conn)
	if _, _, err := wire.ReadResponse(220); err != nil {
		t.Fatal(err)
	}
	command := func(line string, want int) {
		t.Helper()
		if err := wire.PrintfLine("%s", line); err != nil {
			t.Fatal(err)
		}
		if _, _, err := wire.ReadResponse(want); err != nil {
			t.Fatalf("%s: %v", line, err)
		}
	}
	command("EHLO fixture.test", 250)
	command("AUTH PLAIN AGZpeHR1cmUAZml4dHVyZQ==", 523)
	command("STARTTLS", 220)
	pool := x509.NewCertPool()
	pem, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}
	if !pool.AppendCertsFromPEM(pem) {
		t.Fatal("fixture certificate missing")
	}
	secure := tls.Client(conn, &tls.Config{RootCAs: pool, ServerName: "relay.test", MinVersion: tls.VersionTLS12})
	if err := secure.Handshake(); err != nil {
		t.Fatal(err)
	}
	wire = textproto.NewConn(secure)
	command("EHLO fixture.test", 250)
	command("AUTH PLAIN AGZpeHR1cmUAZml4dHVyZQ==", 235)
	command("MAIL FROM:<fixture@example.invalid> BODY=8BITMIME", 250)
	command("RSET", 250)
	command("QUIT", 221)
}
