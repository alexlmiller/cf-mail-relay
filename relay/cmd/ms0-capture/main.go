// Package main implements a disposable SMTP capture server for the MS0 spike.
//
// It is intentionally not the production relay. It accepts STARTTLS + AUTH,
// captures DATA bytes to .eml files, and never forwards mail.
package main

import (
	"crypto/tls"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxCaptureBytes = 8 * 1024 * 1024

type config struct {
	addr     string
	certPath string
	keyPath  string
	outDir   string
	username string
	password string
}

type session struct {
	conn      net.Conn
	tp        *textproto.Conn
	tlsConfig *tls.Config
	cfg       config
	tlsActive bool
	authed    bool
	mailFrom  string
	rcpts     []string
}

func main() {
	cfg := readConfig()

	cert, err := tls.LoadX509KeyPair(cfg.certPath, cfg.keyPath)
	if err != nil {
		log.Fatalf("load TLS certificate: %v", err)
	}
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}

	if err := os.MkdirAll(cfg.outDir, 0o700); err != nil {
		log.Fatalf("create output dir: %v", err)
	}

	listener, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		log.Fatalf("listen on %s: %v", cfg.addr, err)
	}
	defer listener.Close()

	log.Printf("MS0 SMTP capture listening on %s; writing .eml files to %s", cfg.addr, cfg.outDir)
	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			continue
		}

		go func() {
			s := &session{
				conn:      conn,
				tp:        textproto.NewConn(conn),
				tlsConfig: tlsConfig,
				cfg:       cfg,
			}
			if err := s.handle(); err != nil && !errors.Is(err, io.EOF) {
				log.Printf("%s: %v", conn.RemoteAddr(), err)
			}
		}()
	}
}

func readConfig() config {
	var cfg config
	var passwordEnv string
	flag.StringVar(&cfg.addr, "addr", ":587", "SMTP listen address")
	flag.StringVar(&cfg.certPath, "cert", "", "TLS certificate path")
	flag.StringVar(&cfg.keyPath, "key", "", "TLS private key path")
	flag.StringVar(&cfg.outDir, "out", ".ai-runs/ms0-captures", "directory for captured .eml files")
	flag.StringVar(&cfg.username, "username", "", "SMTP AUTH username")
	flag.StringVar(&passwordEnv, "password-env", "MS0_SMTP_PASSWORD", "environment variable containing the SMTP AUTH password")
	flag.Parse()

	cfg.password = os.Getenv(passwordEnv)
	missing := make([]string, 0, 4)
	if cfg.certPath == "" {
		missing = append(missing, "-cert")
	}
	if cfg.keyPath == "" {
		missing = append(missing, "-key")
	}
	if cfg.username == "" {
		missing = append(missing, "-username")
	}
	if cfg.password == "" {
		missing = append(missing, passwordEnv)
	}
	if len(missing) > 0 {
		log.Fatalf("missing required config: %s", strings.Join(missing, ", "))
	}

	return cfg
}

func (s *session) handle() error {
	defer s.conn.Close()

	s.writeLine("220 cf-mail-relay MS0 capture ESMTP")
	for {
		line, err := s.tp.ReadLine()
		if err != nil {
			return err
		}

		cmd, arg := splitCommand(line)
		switch cmd {
		case "EHLO", "HELO":
			s.handleEhlo()
		case "STARTTLS":
			if err := s.handleStartTLS(); err != nil {
				return err
			}
		case "AUTH":
			s.handleAuth(arg)
		case "MAIL":
			s.handleMail(arg)
		case "RCPT":
			s.handleRcpt(arg)
		case "DATA":
			if err := s.handleData(); err != nil {
				return err
			}
		case "RSET":
			s.resetEnvelope()
			s.writeLine("250 2.0.0 Ok")
		case "NOOP":
			s.writeLine("250 2.0.0 Ok")
		case "QUIT":
			s.writeLine("221 2.0.0 Bye")
			return nil
		default:
			s.writeLine("502 5.5.2 Command not implemented")
		}
	}
}

func (s *session) handleEhlo() {
	s.writeLine("250-cf-mail-relay-ms0")
	if !s.tlsActive {
		s.writeLine("250-STARTTLS")
	}
	s.writeLine("250-AUTH PLAIN LOGIN")
	s.writeLine(fmt.Sprintf("250 SIZE %d", maxCaptureBytes))
}

func (s *session) handleStartTLS() error {
	if s.tlsActive {
		s.writeLine("503 5.5.1 TLS already active")
		return nil
	}

	s.writeLine("220 2.0.0 Ready to start TLS")
	tlsConn := tls.Server(s.conn, s.tlsConfig)
	if err := tlsConn.Handshake(); err != nil {
		return fmt.Errorf("tls handshake: %w", err)
	}
	s.conn = tlsConn
	s.tp = textproto.NewConn(tlsConn)
	s.tlsActive = true
	s.resetEnvelope()
	return nil
}

func (s *session) handleAuth(arg string) {
	if !s.tlsActive {
		s.writeLine("530 5.7.0 Must issue STARTTLS first")
		return
	}

	mechanism, initial := splitCommand(arg)
	var username string
	var password string
	var err error

	switch mechanism {
	case "PLAIN":
		if initial == "" {
			s.writeLine("334 ")
			initial, err = s.tp.ReadLine()
			if err != nil {
				s.writeLine("501 5.5.2 Invalid AUTH exchange")
				return
			}
		}
		username, password, err = parseAuthPlain(initial)
	case "LOGIN":
		username, password, err = s.authLogin(initial)
	default:
		s.writeLine("504 5.5.4 Unsupported AUTH mechanism")
		return
	}

	if err != nil {
		s.writeLine("501 5.5.2 Invalid AUTH exchange")
		return
	}
	if username != s.cfg.username || password != s.cfg.password {
		s.writeLine("535 5.7.8 Authentication credentials invalid")
		return
	}

	s.authed = true
	s.writeLine("235 2.7.0 Authentication successful")
}

func (s *session) authLogin(initial string) (string, string, error) {
	var err error
	username := initial
	if username == "" {
		s.writeLine("334 " + base64.StdEncoding.EncodeToString([]byte("Username:")))
		username, err = s.tp.ReadLine()
		if err != nil {
			return "", "", err
		}
	}
	decodedUsername, err := base64.StdEncoding.DecodeString(username)
	if err != nil {
		return "", "", err
	}

	s.writeLine("334 " + base64.StdEncoding.EncodeToString([]byte("Password:")))
	password, err := s.tp.ReadLine()
	if err != nil {
		return "", "", err
	}
	decodedPassword, err := base64.StdEncoding.DecodeString(password)
	if err != nil {
		return "", "", err
	}

	return string(decodedUsername), string(decodedPassword), nil
}

func (s *session) handleMail(arg string) {
	if !s.authed {
		s.writeLine("530 5.7.0 Authentication required")
		return
	}
	if !strings.HasPrefix(strings.ToUpper(arg), "FROM:") {
		s.writeLine("501 5.5.2 Syntax: MAIL FROM:<address>")
		return
	}

	s.mailFrom = strings.TrimSpace(arg[len("FROM:"):])
	s.rcpts = nil
	s.writeLine("250 2.1.0 Sender ok")
}

func (s *session) handleRcpt(arg string) {
	if s.mailFrom == "" {
		s.writeLine("503 5.5.1 Need MAIL before RCPT")
		return
	}
	if !strings.HasPrefix(strings.ToUpper(arg), "TO:") {
		s.writeLine("501 5.5.2 Syntax: RCPT TO:<address>")
		return
	}
	if len(s.rcpts) >= 50 {
		s.writeLine("452 4.5.3 Too many recipients")
		return
	}

	s.rcpts = append(s.rcpts, strings.TrimSpace(arg[len("TO:"):]))
	s.writeLine("250 2.1.5 Recipient ok")
}

func (s *session) handleData() error {
	if len(s.rcpts) == 0 {
		s.writeLine("503 5.5.1 Need RCPT before DATA")
		return nil
	}

	s.writeLine("354 End data with <CR><LF>.<CR><LF>")
	limitedReader := io.LimitReader(s.tp.DotReader(), maxCaptureBytes+1)
	data, err := io.ReadAll(limitedReader)
	if err != nil {
		return fmt.Errorf("read DATA: %w", err)
	}
	if len(data) > maxCaptureBytes {
		s.writeLine("552 5.3.4 Message too large")
		return nil
	}

	path, err := s.writeCapture(data)
	if err != nil {
		s.writeLine("451 4.3.0 Could not store capture")
		return err
	}
	log.Printf("captured %d bytes from %s to %v in %s", len(data), s.mailFrom, s.rcpts, path)
	s.writeLine("250 2.0.0 Captured " + filepath.Base(path))
	s.resetEnvelope()
	return nil
}

func (s *session) writeCapture(data []byte) (string, error) {
	name := fmt.Sprintf("%s-%s.eml", time.Now().UTC().Format("20060102T150405.000000000Z"), sanitizeFilename(s.mailFrom))
	path := filepath.Join(s.cfg.outDir, name)
	return path, os.WriteFile(path, data, 0o600)
}

func (s *session) writeLine(line string) {
	if err := s.tp.PrintfLine(line); err != nil {
		log.Printf("%s: write: %v", s.conn.RemoteAddr(), err)
	}
}

func (s *session) resetEnvelope() {
	s.mailFrom = ""
	s.rcpts = nil
}

func splitCommand(line string) (string, string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", ""
	}
	cmd, arg, found := strings.Cut(line, " ")
	if !found {
		return strings.ToUpper(cmd), ""
	}
	return strings.ToUpper(cmd), strings.TrimSpace(arg)
}

func parseAuthPlain(encoded string) (string, string, error) {
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", err
	}

	parts := strings.Split(string(decoded), "\x00")
	if len(parts) != 3 {
		return "", "", errors.New("AUTH PLAIN payload must contain authzid, authcid, passwd")
	}

	return parts[1], parts[2], nil
}

func sanitizeFilename(raw string) string {
	replacer := strings.NewReplacer("<", "", ">", "", "@", "_at_", ".", "_", " ", "_", ":", "_", "/", "_", "\\", "_")
	name := replacer.Replace(raw)
	if name == "" {
		return "unknown"
	}
	return name
}
