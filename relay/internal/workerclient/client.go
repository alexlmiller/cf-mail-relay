package workerclient

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/alexlmiller/cf-mail-relay/relay/internal/hmacsign"
)

type Client struct {
	BaseURL    string
	KeyID      string
	Secret     string
	Version    string
	HTTPClient *http.Client

	mu            sync.Mutex
	authCache     map[string]authCacheEntry
	policyVersion string
}

type AuthResponse struct {
	OK             bool     `json:"ok"`
	Error          string   `json:"error,omitempty"`
	TTLSeconds     int      `json:"ttl_seconds,omitempty"`
	PolicyVersion  string   `json:"policy_version,omitempty"`
	UserID         string   `json:"user_id,omitempty"`
	CredentialID   string   `json:"credential_id,omitempty"`
	AllowedSenders []string `json:"allowed_senders,omitempty"`
}

type SendResponse struct {
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
	CFStatus int    `json:"cf_status,omitempty"`
}

type authCacheEntry struct {
	response  AuthResponse
	expiresAt time.Time
}

func (c *Client) Auth(ctx context.Context, username, password string) (*AuthResponse, error) {
	cacheKey := authCacheKey(username, password)
	if cached, ok := c.cachedAuth(cacheKey); ok {
		return cached, nil
	}

	body, err := json.Marshal(struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}{Username: username, Password: password})
	if err != nil {
		return nil, err
	}

	var response AuthResponse
	status, err := c.post(ctx, "/relay/auth", body, nil, &response)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK || !response.OK {
		if response.Error == "" {
			response.Error = http.StatusText(status)
		}
		return &response, fmt.Errorf("relay auth rejected: %s", response.Error)
	}
	c.storeAuth(cacheKey, response)
	return &response, nil
}

func (c *Client) Send(ctx context.Context, auth *AuthResponse, envelopeFrom string, recipients []string, mime []byte, traceID string) (*SendResponse, error) {
	headers := map[string]string{
		"content-type":          "message/rfc822",
		"x-relay-envelope-from": envelopeFrom,
		"x-relay-recipients":    strings.Join(recipients, ","),
	}
	if traceID != "" {
		headers["x-relay-trace-id"] = traceID
	}
	if auth != nil {
		headers["x-relay-credential-id"] = auth.CredentialID
		headers["x-relay-policy-version"] = auth.PolicyVersion
	}
	var response SendResponse
	status, err := c.post(ctx, "/relay/send", mime, headers, &response)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK || !response.OK {
		if response.Error == "" {
			response.Error = http.StatusText(status)
		}
		return &response, fmt.Errorf("relay send rejected: %s", response.Error)
	}
	return &response, nil
}

func (c *Client) post(ctx context.Context, path string, body []byte, headers map[string]string, out any) (int, error) {
	endpoint, err := url.JoinPath(c.BaseURL, path)
	if err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	c.sign(request, path, body)

	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	c.observePolicyVersion(response.Header.Get("x-relay-policy-version"))

	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return response.StatusCode, err
	}
	if len(raw) > 0 && out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return response.StatusCode, fmt.Errorf("decode worker response: %w", err)
		}
	}
	return response.StatusCode, nil
}

func (c *Client) cachedAuth(key string) (*AuthResponse, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.authCache == nil {
		return nil, false
	}
	entry, ok := c.authCache[key]
	if !ok || time.Now().After(entry.expiresAt) {
		delete(c.authCache, key)
		return nil, false
	}
	response := entry.response
	return &response, true
}

func (c *Client) storeAuth(key string, response AuthResponse) {
	ttl := response.TTLSeconds
	if ttl <= 0 || ttl > 5 {
		ttl = 5
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.authCache == nil {
		c.authCache = make(map[string]authCacheEntry)
	}
	c.authCache[key] = authCacheEntry{response: response, expiresAt: time.Now().Add(time.Duration(ttl) * time.Second)}
	if response.PolicyVersion != "" {
		c.policyVersion = response.PolicyVersion
	}
}

func (c *Client) observePolicyVersion(version string) {
	if version == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.policyVersion == "" {
		c.policyVersion = version
		return
	}
	if c.policyVersion != version {
		c.policyVersion = version
		clear(c.authCache)
	}
}

func (c *Client) sign(request *http.Request, path string, body []byte) {
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	nonce := randomNonce()
	bodySHA256 := hmacsign.SHA256Hex(body)
	request.Header.Set("X-Relay-Version", c.Version)
	signedHeaders := signedHeadersForRequest(request)
	request.Header.Set("X-Relay-Signed-Headers", hmacsign.SignedHeaderNames(signedHeaders))
	signature := hmacsign.Sign(hmacsign.Input{
		Method:     request.Method,
		Path:       path,
		Timestamp:  timestamp,
		Nonce:      nonce,
		BodySHA256: bodySHA256,
		KeyID:      c.KeyID,
		Headers:    signedHeaders,
	}, c.Secret)

	request.Header.Set("X-Relay-Key-Id", c.KeyID)
	request.Header.Set("X-Relay-Timestamp", timestamp)
	request.Header.Set("X-Relay-Nonce", nonce)
	request.Header.Set("X-Relay-Body-SHA256", bodySHA256)
	request.Header.Set("X-Relay-Signature", signature)
}

func signedHeadersForRequest(request *http.Request) map[string]string {
	headers := map[string]string{
		"x-relay-version": request.Header.Get("X-Relay-Version"),
	}
	// X-Relay-Trace-Id is intentionally unsigned; it is diagnostic only and
	// must not affect authorization or replay semantics.
	for _, name := range []string{"X-Relay-Envelope-From", "X-Relay-Recipients", "X-Relay-Credential-Id"} {
		if value := request.Header.Get(name); value != "" {
			headers[strings.ToLower(name)] = value
		}
	}
	return headers
}

func authCacheKey(username, password string) string {
	sum := sha256.Sum256([]byte(username + "\x00" + password))
	return hex.EncodeToString(sum[:])
}

func randomNonce() string {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(nonce[:])
}
