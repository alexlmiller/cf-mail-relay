// Package main is the entry point for the cf-mail-relay SMTP daemon.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
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
	MaxMessageBytes   int64
	AllowInsecureAuth bool
	ConnPerMinute     int
	AuthPerMinute     int
	AuthLockoutBase   time.Duration
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
		maxMessageBytes: cfg.MaxMessageBytes,
		throttle:        newThrottle(cfg.ConnPerMinute, cfg.AuthPerMinute, cfg.AuthLockoutBase),
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
	maxMessageBytes int64
	throttle        *throttle
}

func (b *backend) NewSession(conn *smtp.Conn) (smtp.Session, error) {
	remoteIP := remoteIP(conn)
	if !b.throttle.allowConn(remoteIP) {
		return nil, smtpError(421, smtp.EnhancedCode{4, 7, 0}, "too many connections; try again later")
	}
	return &session{backend: b, remoteIP: remoteIP}, nil
}

type session struct {
	backend      *backend
	authed       bool
	authDecision *workerclient.AuthResponse
	mailFrom     string
	recipients   []string
	remoteIP     string
}

func (s *session) AuthMechanisms() []string {
	return []string{sasl.Plain, sasl.Login}
}

func (s *session) Auth(mech string) (sasl.Server, error) {
	authenticate := func(username, password string) error {
		if !s.backend.throttle.allowAuth(username) {
			return smtp.ErrAuthFailed
		}
		response, err := s.backend.client.Auth(context.Background(), username, password)
		if err != nil {
			s.backend.throttle.recordAuthFailure(username)
			return smtp.ErrAuthFailed
		}
		s.backend.throttle.recordAuthSuccess(username)
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
	if s.authDecision == nil {
		return smtp.ErrAuthRequired
	}
	if !senderAllowed(from, s.authDecision.AllowedSenders) {
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

	traceID := newTraceID()
	if _, err := s.backend.client.Send(context.Background(), s.authDecision, s.mailFrom, s.recipients, mime, traceID); err != nil {
		return smtpError(451, smtp.EnhancedCode{4, 7, 1}, "upstream send failed; try again later")
	}
	log.Printf("accepted message trace_id=%s from=%s recipients=%d bytes=%d", traceID, s.mailFrom, len(s.recipients), len(mime))
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
		MaxMessageBytes: defaultMaxMessageBytes,
		ConnPerMinute:   60,
		AuthPerMinute:   20,
		AuthLockoutBase: 30 * time.Second,
	}
	if raw := os.Getenv("RELAY_MAX_BYTES"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			return config{}, fmt.Errorf("invalid RELAY_MAX_BYTES")
		}
		cfg.MaxMessageBytes = parsed
	}
	if raw := os.Getenv("RELAY_CONN_PER_MIN"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			return config{}, fmt.Errorf("invalid RELAY_CONN_PER_MIN")
		}
		cfg.ConnPerMinute = parsed
	}
	if raw := os.Getenv("RELAY_AUTH_PER_MIN"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			return config{}, fmt.Errorf("invalid RELAY_AUTH_PER_MIN")
		}
		cfg.AuthPerMinute = parsed
	}
	if raw := os.Getenv("RELAY_AUTH_LOCKOUT_BASE_SECONDS"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			return config{}, fmt.Errorf("invalid RELAY_AUTH_LOCKOUT_BASE_SECONDS")
		}
		cfg.AuthLockoutBase = time.Duration(parsed) * time.Second
	}
	cfg.AllowInsecureAuth = os.Getenv("RELAY_ALLOW_INSECURE_AUTH") == "1" || os.Getenv("RELAY_ALLOW_INSECURE_AUTH") == "true"
	for name, value := range map[string]string{
		"RELAY_TLS_CERT_FILE":   cfg.CertFile,
		"RELAY_TLS_KEY_FILE":    cfg.KeyFile,
		"RELAY_WORKER_URL":      cfg.WorkerURL,
		"RELAY_KEY_ID":          cfg.HMACKeyID,
		"RELAY_HMAC_SECRET":     cfg.HMACSecret,
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

type throttle struct {
	mu              sync.Mutex
	connPerMinute   int
	authPerMinute   int
	authLockoutBase time.Duration
	connCounts      map[string]int
	authCounts      map[string]int
	authFailures    map[string]authFailure
}

type authFailure struct {
	count       int
	blockUntil  time.Time
	lastFailure time.Time
}

func newThrottle(connPerMinute, authPerMinute int, authLockoutBase time.Duration) *throttle {
	return &throttle{
		connPerMinute:   connPerMinute,
		authPerMinute:   authPerMinute,
		authLockoutBase: authLockoutBase,
		connCounts:      make(map[string]int),
		authCounts:      make(map[string]int),
		authFailures:    make(map[string]authFailure),
	}
}

func (t *throttle) allowConn(remoteIP string) bool {
	if t == nil || t.connPerMinute <= 0 {
		return true
	}
	key := fmt.Sprintf("%s:%s", minuteBucket(), remoteIP)
	t.mu.Lock()
	defer t.mu.Unlock()
	t.connCounts[key]++
	return t.connCounts[key] <= t.connPerMinute
}

func (t *throttle) allowAuth(username string) bool {
	if t == nil {
		return true
	}
	key := strings.ToLower(strings.TrimSpace(username))
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	if failure, ok := t.authFailures[key]; ok && now.Before(failure.blockUntil) {
		return false
	}
	if t.authPerMinute <= 0 {
		return true
	}
	countKey := fmt.Sprintf("%s:%s", minuteBucket(), key)
	t.authCounts[countKey]++
	return t.authCounts[countKey] <= t.authPerMinute
}

func (t *throttle) recordAuthFailure(username string) {
	if t == nil || t.authLockoutBase <= 0 {
		return
	}
	key := strings.ToLower(strings.TrimSpace(username))
	t.mu.Lock()
	defer t.mu.Unlock()
	failure := t.authFailures[key]
	failure.count++
	failure.lastFailure = time.Now()
	lockout := t.authLockoutBase * time.Duration(1<<(min(failure.count, 6)-1))
	if lockout > 15*time.Minute {
		lockout = 15 * time.Minute
	}
	failure.blockUntil = failure.lastFailure.Add(lockout)
	t.authFailures[key] = failure
}

func (t *throttle) recordAuthSuccess(username string) {
	if t == nil {
		return
	}
	key := strings.ToLower(strings.TrimSpace(username))
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.authFailures, key)
}

func remoteIP(conn *smtp.Conn) string {
	if conn == nil || conn.Conn() == nil || conn.Conn().RemoteAddr() == nil {
		return "unknown"
	}
	host, _, err := net.SplitHostPort(conn.Conn().RemoteAddr().String())
	if err != nil {
		return conn.Conn().RemoteAddr().String()
	}
	return host
}

func minuteBucket() string {
	return time.Now().UTC().Format("200601021504")
}

func newTraceID() string {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return fmt.Sprintf("trace_%d", time.Now().UnixNano())
	}
	return "trace_" + base64.RawURLEncoding.EncodeToString(random[:])
}
