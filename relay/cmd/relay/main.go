// Package main is the entry point for the cf-mail-relay SMTP daemon.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/alexlmiller/cf-mail-relay/relay/internal/workerclient"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

const version = "0.1.0-ms2"
const defaultMaxMessageBytes = 4_718_592

type config struct {
	ListenAddr        string
	Domain            string
	CertFile          string
	KeyFile           string
	WorkerURL         string
	HMACKeyID         string
	HMACSecret        string
	AllowedSenders    []string
	MaxMessageBytes   int64
	AllowInsecureAuth bool
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--healthcheck" {
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}

	cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
	if err != nil {
		log.Fatalf("load TLS certificate: %v", err)
	}

	be := &backend{
		client: &workerclient.Client{
			BaseURL: cfg.WorkerURL,
			KeyID:   cfg.HMACKeyID,
			Secret:  cfg.HMACSecret,
			Version: version,
			HTTPClient: &http.Client{
				Timeout: 30 * time.Second,
			},
		},
		allowedSenders:  cfg.AllowedSenders,
		maxMessageBytes: cfg.MaxMessageBytes,
	}

	server := smtp.NewServer(be)
	server.Addr = cfg.ListenAddr
	server.Domain = cfg.Domain
	server.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	server.AllowInsecureAuth = cfg.AllowInsecureAuth
	server.MaxMessageBytes = cfg.MaxMessageBytes
	server.MaxRecipients = 50
	server.ReadTimeout = 2 * time.Minute
	server.WriteTimeout = 2 * time.Minute

	log.Printf("cf-mail-relay %s listening on %s", version, cfg.ListenAddr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

type backend struct {
	client          *workerclient.Client
	allowedSenders  []string
	maxMessageBytes int64
}

func (b *backend) NewSession(_ *smtp.Conn) (smtp.Session, error) {
	return &session{backend: b}, nil
}

type session struct {
	backend      *backend
	authed       bool
	authDecision *workerclient.AuthResponse
	mailFrom     string
	recipients   []string
}

func (s *session) AuthMechanisms() []string {
	return []string{sasl.Plain, sasl.Login}
}

func (s *session) Auth(mech string) (sasl.Server, error) {
	authenticate := func(username, password string) error {
		response, err := s.backend.client.Auth(context.Background(), username, password)
		if err != nil {
			return smtp.ErrAuthFailed
		}
		s.authed = true
		s.authDecision = response
		return nil
	}

	switch strings.ToUpper(mech) {
	case sasl.Plain:
		return sasl.NewPlainServer(func(_, username, password string) error {
			return authenticate(username, password)
		}), nil
	case sasl.Login:
		return &loginServer{authenticate: authenticate}, nil
	default:
		return nil, smtp.ErrAuthUnknownMechanism
	}
}

func (s *session) Mail(from string, opts *smtp.MailOptions) error {
	if !s.authed {
		return smtp.ErrAuthRequired
	}
	if opts != nil {
		if opts.Body == smtp.Body8BitMIME || opts.Body == smtp.BodyBinaryMIME {
			return smtpError(554, smtp.EnhancedCode{5, 6, 0}, "8-bit content not supported in MVP; use base64 or quoted-printable")
		}
		if opts.Size > s.backend.maxMessageBytes {
			return smtpError(552, smtp.EnhancedCode{5, 3, 4}, "message too large")
		}
	}
	allowedSenders := s.backend.allowedSenders
	if s.authDecision != nil {
		allowedSenders = s.authDecision.AllowedSenders
	}
	if !senderAllowed(from, allowedSenders) {
		return smtpError(553, smtp.EnhancedCode{5, 7, 1}, "sender not allowed")
	}
	s.mailFrom = from
	s.recipients = nil
	return nil
}

func (s *session) Rcpt(to string, _ *smtp.RcptOptions) error {
	if !s.authed {
		return smtp.ErrAuthRequired
	}
	if s.mailFrom == "" {
		return smtpError(503, smtp.EnhancedCode{5, 5, 1}, "need MAIL before RCPT")
	}
	if len(s.recipients) >= 50 {
		return smtpError(452, smtp.EnhancedCode{4, 5, 3}, "too many recipients")
	}
	s.recipients = append(s.recipients, to)
	return nil
}

func (s *session) Data(r io.Reader) error {
	if !s.authed {
		return smtp.ErrAuthRequired
	}
	if len(s.recipients) == 0 {
		return smtpError(503, smtp.EnhancedCode{5, 5, 1}, "need RCPT before DATA")
	}

	mime, err := io.ReadAll(io.LimitReader(r, s.backend.maxMessageBytes+1))
	if err != nil {
		return err
	}
	if int64(len(mime)) > s.backend.maxMessageBytes {
		return smtpError(552, smtp.EnhancedCode{5, 3, 4}, "message too large")
	}
	if contains8Bit(mime) {
		return smtpError(554, smtp.EnhancedCode{5, 6, 0}, "8-bit content not supported in MVP; use base64 or quoted-printable")
	}

	if _, err := s.backend.client.Send(context.Background(), s.authDecision, s.mailFrom, s.recipients, mime); err != nil {
		return smtpError(451, smtp.EnhancedCode{4, 7, 1}, "upstream send failed; try again later")
	}
	log.Printf("accepted message from=%s recipients=%d bytes=%d", s.mailFrom, len(s.recipients), len(mime))
	s.Reset()
	return nil
}

func (s *session) Reset() {
	s.mailFrom = ""
	s.recipients = nil
}

func (s *session) Logout() error {
	s.Reset()
	s.authDecision = nil
	s.authed = false
	return nil
}

type loginServer struct {
	step         int
	username     string
	authenticate func(username, password string) error
}

func (s *loginServer) Next(response []byte) ([]byte, bool, error) {
	switch s.step {
	case 0:
		if response == nil {
			s.step = 1
			return []byte("Username:"), false, nil
		}
		s.step = 2
		s.username = string(response)
		return []byte("Password:"), false, nil
	case 1:
		s.step = 2
		s.username = string(response)
		return []byte("Password:"), false, nil
	case 2:
		s.step = 3
		if err := s.authenticate(s.username, string(response)); err != nil {
			return nil, true, err
		}
		return nil, true, nil
	default:
		return nil, true, errors.New("unexpected AUTH LOGIN response")
	}
}

func loadConfig() (config, error) {
	cfg := config{
		ListenAddr:      envOrDefault("RELAY_LISTEN_ADDR", ":587"),
		Domain:          envOrDefault("RELAY_DOMAIN", "localhost"),
		CertFile:        os.Getenv("RELAY_TLS_CERT_FILE"),
		KeyFile:         os.Getenv("RELAY_TLS_KEY_FILE"),
		WorkerURL:       strings.TrimRight(os.Getenv("RELAY_WORKER_URL"), "/"),
		HMACKeyID:       os.Getenv("RELAY_KEY_ID"),
		HMACSecret:      os.Getenv("RELAY_HMAC_SECRET"),
		AllowedSenders:  splitCSV(os.Getenv("RELAY_ALLOWED_SENDERS")),
		MaxMessageBytes: defaultMaxMessageBytes,
	}
	if raw := os.Getenv("RELAY_MAX_BYTES"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			return config{}, fmt.Errorf("invalid RELAY_MAX_BYTES")
		}
		cfg.MaxMessageBytes = parsed
	}
	cfg.AllowInsecureAuth = os.Getenv("RELAY_ALLOW_INSECURE_AUTH") == "1" || os.Getenv("RELAY_ALLOW_INSECURE_AUTH") == "true"
	for name, value := range map[string]string{
		"RELAY_TLS_CERT_FILE":   cfg.CertFile,
		"RELAY_TLS_KEY_FILE":    cfg.KeyFile,
		"RELAY_WORKER_URL":      cfg.WorkerURL,
		"RELAY_KEY_ID":          cfg.HMACKeyID,
		"RELAY_HMAC_SECRET":     cfg.HMACSecret,
		"RELAY_ALLOWED_SENDERS": "worker-policy-ms2",
	} {
		if value == "" {
			return config{}, fmt.Errorf("%s is required", name)
		}
	}
	return cfg, nil
}

func senderAllowed(sender string, allowed []string) bool {
	sender = strings.ToLower(strings.Trim(sender, "<> "))
	for _, entry := range allowed {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry == sender {
			return true
		}
		if strings.HasPrefix(entry, "*@") && strings.HasSuffix(sender, entry[1:]) {
			return true
		}
	}
	return false
}

func contains8Bit(body []byte) bool {
	for _, b := range body {
		if b >= 0x80 {
			return true
		}
	}
	return false
}

func smtpError(code int, enhanced smtp.EnhancedCode, message string) error {
	return &smtp.SMTPError{Code: code, EnhancedCode: enhanced, Message: message}
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func splitCSV(raw string) []string {
	var values []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			values = append(values, part)
		}
	}
	return values
}
