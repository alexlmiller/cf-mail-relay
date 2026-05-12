package main

import (
	"errors"
	"testing"
	"time"

	"github.com/alexlmiller/cf-mail-relay/relay/internal/workerclient"
	"github.com/emersion/go-smtp"
)

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
