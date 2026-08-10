package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexlmiller/cf-mail-relay/relay/internal/workerclient"
	"github.com/emersion/go-smtp"
)

func TestLoadX509KeyPairFromCombinedPEMBundle(t *testing.T) {
	bundlePath := writeTestCertificateBundle(
		t,
		time.Now().Add(-time.Minute),
		time.Now().Add(time.Hour),
		"relay.test",
	)

	if _, err := tls.LoadX509KeyPair(bundlePath, bundlePath); err != nil {
		t.Fatalf("load combined certificate and key bundle: %v", err)
	}
}

func writeTestCertificateBundle(t *testing.T, notBefore, notAfter time.Time, dnsNames ...string) string {
	t.Helper()

	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	commonName := "relay.test"
	if len(dnsNames) > 0 {
		commonName = dnsNames[0]
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: commonName},
		DNSNames:     dnsNames,
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}

	bundle := append(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKeyDER})...,
	)
	bundlePath := filepath.Join(t.TempDir(), "relay.pem")
	if err := os.WriteFile(bundlePath, bundle, 0o600); err != nil {
		t.Fatal(err)
	}
	return bundlePath
}

func TestValidateConfiguredCertificate(t *testing.T) {
	now := time.Date(2026, time.August, 10, 20, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		notBefore time.Time
		notAfter  time.Time
		dnsName   string
		domain    string
		wantErr   string
	}{
		{
			name:      "valid",
			notBefore: now.Add(-time.Hour),
			notAfter:  now.Add(time.Hour),
			dnsName:   "relay.test",
			domain:    "relay.test",
		},
		{
			name:      "expired",
			notBefore: now.Add(-2 * time.Hour),
			notAfter:  now.Add(-time.Hour),
			dnsName:   "relay.test",
			domain:    "relay.test",
			wantErr:   "certificate expired at",
		},
		{
			name:      "not yet valid",
			notBefore: now.Add(time.Hour),
			notAfter:  now.Add(2 * time.Hour),
			dnsName:   "relay.test",
			domain:    "relay.test",
			wantErr:   "certificate is not valid before",
		},
		{
			name:      "wrong hostname",
			notBefore: now.Add(-time.Hour),
			notAfter:  now.Add(time.Hour),
			dnsName:   "other.test",
			domain:    "relay.test",
			wantErr:   "certificate is not valid for RELAY_DOMAIN",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bundlePath := writeTestCertificateBundle(t, test.notBefore, test.notAfter, test.dnsName)
			err := validateConfiguredCertificate(bundlePath, bundlePath, test.domain, now)
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("validateConfiguredCertificate() error = %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("validateConfiguredCertificate() error = %v, want substring %q", err, test.wantErr)
			}
		})
	}
}

func TestLocalHealthcheckAddress(t *testing.T) {
	tests := []struct {
		listen string
		want   string
	}{
		{listen: ":587", want: "127.0.0.1:587"},
		{listen: "0.0.0.0:2525", want: "127.0.0.1:2525"},
		{listen: "[::]:587", want: "127.0.0.1:587"},
		{listen: "127.0.0.2:587", want: "127.0.0.2:587"},
	}
	for _, test := range tests {
		t.Run(test.listen, func(t *testing.T) {
			got, err := localHealthcheckAddress(test.listen)
			if err != nil {
				t.Fatalf("localHealthcheckAddress() error = %v", err)
			}
			if got != test.want {
				t.Fatalf("localHealthcheckAddress() = %q want %q", got, test.want)
			}
		})
	}
}

func TestCheckSMTPBanner(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	done := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			done <- acceptErr
			return
		}
		defer conn.Close()
		_, writeErr := conn.Write([]byte("220 relay.test ESMTP ready\r\n"))
		done <- writeErr
	}()

	if err := checkSMTPBanner(listener.Addr().String(), time.Second); err != nil {
		t.Fatalf("checkSMTPBanner() error = %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("SMTP fixture error = %v", err)
	}
}

func TestHealthcheckTimeoutFitsComposeBudget(t *testing.T) {
	const composeTimeout = 5 * time.Second
	if healthcheckTimeout != 4*time.Second {
		t.Fatalf("healthcheckTimeout = %s want 4s", healthcheckTimeout)
	}
	if healthcheckTimeout >= composeTimeout {
		t.Fatalf("healthcheck timeout %s must leave time inside Compose timeout %s", healthcheckTimeout, composeTimeout)
	}
}

func TestSenderAllowed(t *testing.T) {
	tests := []struct {
		name    string
		sender  string
		allowed []string
		want    bool
	}{
		{name: "exact", sender: "<gmail@alexmiller.net>", allowed: []string{"gmail@alexmiller.net"}, want: true},
		{name: "wildcard", sender: "alex@alexmiller.net", allowed: []string{"*@alexmiller.net"}, want: true},
		{name: "wildcard does not match subdomain", sender: "alex@evil.alexmiller.net", allowed: []string{"*@alexmiller.net"}, want: false},
		{name: "wildcard dot form is not supported", sender: "alex@foo.alexmiller.net", allowed: []string{"*@.alexmiller.net"}, want: false},
		{name: "trailing dot does not match", sender: "alex@alexmiller.net.", allowed: []string{"*@alexmiller.net"}, want: false},
		{name: "reject", sender: "alex@example.net", allowed: []string{"*@alexmiller.net"}, want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := senderAllowed(test.sender, test.allowed); got != test.want {
				t.Fatalf("senderAllowed() = %v want %v", got, test.want)
			}
		})
	}
}

func TestContains8Bit(t *testing.T) {
	if contains8Bit([]byte("plain ascii\r\n")) {
		t.Fatal("ascii detected as 8-bit")
	}
	if !contains8Bit([]byte("café")) {
		t.Fatal("utf-8 bytes not detected as 8-bit")
	}
}

func TestThrottleLimitsConnectionsPerMinute(t *testing.T) {
	throttle := newThrottle(2, 20, 30)
	if !throttle.allowConn("192.0.2.10") || !throttle.allowConn("192.0.2.10") {
		t.Fatal("first two connections should be allowed")
	}
	if throttle.allowConn("192.0.2.10") {
		t.Fatal("third connection should be limited")
	}
	if !throttle.allowConn("192.0.2.11") {
		t.Fatal("different remote IP should have its own bucket")
	}
}

func TestThrottleLocksOutAfterAuthFailure(t *testing.T) {
	throttle := newThrottle(60, 20, 30*time.Second)
	if !throttle.allowAuth("gmail", "192.0.2.10") {
		t.Fatal("first auth should be allowed")
	}
	throttle.recordAuthFailure("gmail", "192.0.2.10")
	if throttle.allowAuth("gmail", "192.0.2.10") {
		t.Fatal("failed username/remote pair should be locked out")
	}
	if !throttle.allowAuth("gmail", "192.0.2.11") {
		t.Fatal("same username from a different remote should not be locked out")
	}
	throttle.recordAuthSuccess("gmail", "192.0.2.10")
	if !throttle.allowAuth("gmail", "192.0.2.10") {
		t.Fatal("success should clear lockout")
	}
}

func TestSessionAuthOnlyLocksOutExplicitInvalidCredentials(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		body       string
		wantCode   int
		wantLocked bool
	}{
		{name: "invalid credentials", status: 401, body: `{"ok":false,"error":"invalid_credentials"}`, wantCode: 535, wantLocked: true},
		{name: "HMAC drift", status: 401, body: `{"ok":false,"error":"invalid_signature"}`, wantCode: 454},
		{name: "rate limited", status: 429, body: `{"ok":false,"error":"rate_limited"}`, wantCode: 454},
		{name: "worker outage", status: 503, body: `{"ok":false,"error":"unavailable"}`, wantCode: 454},
		{name: "malformed response", status: 500, body: `not-json`, wantCode: 454},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("content-type", "application/json")
				w.WriteHeader(test.status)
				w.Write([]byte(test.body))
			}))
			defer server.Close()

			throttle := newThrottle(60, 20, 30*time.Second)
			session := &session{
				backend: &backend{
					client:   &workerclient.Client{BaseURL: server.URL, KeyID: "rel_test", Secret: "secret", Version: "test"},
					throttle: throttle,
				},
				remoteIP: "192.0.2.10",
			}
			err := session.authenticate("gmail", "pw")
			var smtpErr *smtp.SMTPError
			if !errors.As(err, &smtpErr) || smtpErr.Code != test.wantCode {
				t.Fatalf("auth error = %#v, want SMTP %d", err, test.wantCode)
			}
			if got := len(throttle.authFailures) > 0; got != test.wantLocked {
				t.Fatalf("locked = %v want %v", got, test.wantLocked)
			}
		})
	}
}

func TestSessionAuthRateLimitIsTemporaryWithoutLockout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(workerclient.AuthResponse{OK: true, TTLSeconds: 1})
	}))
	defer server.Close()

	throttle := newThrottle(60, 1, 30*time.Second)
	session := &session{
		backend: &backend{
			client:   &workerclient.Client{BaseURL: server.URL, KeyID: "rel_test", Secret: "secret", Version: "test"},
			throttle: throttle,
		},
		remoteIP: "192.0.2.10",
	}
	if err := session.authenticate("gmail", "pw"); err != nil {
		t.Fatal(err)
	}
	err := session.authenticate("gmail", "pw")
	var smtpErr *smtp.SMTPError
	if !errors.As(err, &smtpErr) || smtpErr.Code != 454 {
		t.Fatalf("rate-limited auth = %#v, want SMTP 454", err)
	}
	if len(throttle.authFailures) != 0 {
		t.Fatal("rate limiting must not create a credential lockout")
	}
}

func TestSessionAuthLockoutIsTemporary(t *testing.T) {
	throttle := newThrottle(60, 20, 30*time.Second)
	throttle.recordAuthFailure("gmail", "192.0.2.10")
	session := &session{
		backend:  &backend{throttle: throttle},
		remoteIP: "192.0.2.10",
	}

	err := session.authenticate("gmail", "correct-password")
	var smtpErr *smtp.SMTPError
	if !errors.As(err, &smtpErr) || smtpErr.Code != 454 {
		t.Fatalf("locked-out auth = %#v, want SMTP 454", err)
	}
}

func TestSmtpErrorForSendError(t *testing.T) {
	err := smtpErrorForSendError(&workerclient.SendError{
		StatusCode: 403,
		Response:   workerclient.SendResponse{OK: false, Error: "from_header_mismatch"},
	})
	var smtpErr *smtp.SMTPError
	if !errors.As(err, &smtpErr) {
		t.Fatalf("expected SMTPError, got %T", err)
	}
	if smtpErr.Code != 550 {
		t.Fatalf("code = %d want 550", smtpErr.Code)
	}

	err = smtpErrorForSendError(&workerclient.SendError{
		StatusCode: 429,
		Response:   workerclient.SendResponse{OK: false, Error: "rate_limited"},
	})
	if !errors.As(err, &smtpErr) || smtpErr.Code != 451 {
		t.Fatalf("rate limit should be transient 451, got %#v", err)
	}

	err = smtpErrorForSendError(&workerclient.SendError{
		StatusCode: 422,
		Response:   workerclient.SendResponse{OK: false, ErrorCode: "cloudflare_send_raw_permanent_failure", CFErrorCode: "10000"},
	})
	if !errors.As(err, &smtpErr) || smtpErr.Code != 550 {
		t.Fatalf("permanent Cloudflare failure should be 550, got %#v", err)
	}
}

func TestSmtpErrorForRetryableRelayFailures(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		error  string
	}{
		{name: "HMAC drift", status: 401, error: "invalid_signature"},
		{name: "operator not found", status: 404, error: "worker_route_not_found"},
		{name: "rate limit", status: 429, error: "rate_limited"},
		{name: "worker error", status: 500, error: "internal_error"},
		{name: "unknown client error", status: 400, error: "unknown_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := smtpErrorForSendError(&workerclient.SendError{
				StatusCode: test.status,
				Response:   workerclient.SendResponse{OK: false, Error: test.error},
			})
			var smtpErr *smtp.SMTPError
			if !errors.As(err, &smtpErr) || smtpErr.Code != 451 {
				t.Fatalf("relay failure = %#v, want SMTP 451", err)
			}
		})
	}
}

func TestNewTraceID(t *testing.T) {
	first := newTraceID()
	second := newTraceID()
	if first == second || first == "" || second == "" {
		t.Fatalf("trace IDs should be unique non-empty values: %q %q", first, second)
	}
}

func TestLoginServerInitialResponse(t *testing.T) {
	server := &loginServer{
		authenticate: func(username, password string) error {
			if username != "gmail" || password != "secret" {
				t.Fatalf("credentials = %q/%q", username, password)
			}
			return nil
		},
	}

	challenge, done, err := server.Next([]byte("gmail"))
	if err != nil || done || string(challenge) != "Password:" {
		t.Fatalf("first step challenge=%q done=%v err=%v", string(challenge), done, err)
	}
	_, done, err = server.Next([]byte("secret"))
	if err != nil || !done {
		t.Fatalf("second step done=%v err=%v", done, err)
	}
}

func TestLoginServerChallengeFlow(t *testing.T) {
	server := &loginServer{
		authenticate: func(username, password string) error {
			if username != "gmail" || password != "secret" {
				return errors.New("bad credentials")
			}
			return nil
		},
	}

	challenge, done, err := server.Next(nil)
	if err != nil || done || string(challenge) != "Username:" {
		t.Fatalf("username challenge=%q done=%v err=%v", string(challenge), done, err)
	}
	challenge, done, err = server.Next([]byte("gmail"))
	if err != nil || done || string(challenge) != "Password:" {
		t.Fatalf("password challenge=%q done=%v err=%v", string(challenge), done, err)
	}
	_, done, err = server.Next([]byte("secret"))
	if err != nil || !done {
		t.Fatalf("done=%v err=%v", done, err)
	}
}
