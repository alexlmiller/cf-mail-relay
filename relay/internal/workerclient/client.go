package workerclient

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/alexlmiller/cf-mail-relay/relay/internal/hmacsign"
)

type Client struct {
	BaseURL    string
	KeyID      string
	Secret     string
	Version    string
	HTTPClient *http.Client
}

type AuthResponse struct {
	OK             bool     `json:"ok"`
	Error          string   `json:"error,omitempty"`
	TTLSeconds     int      `json:"ttl_seconds,omitempty"`
	PolicyVersion  string   `json:"policy_version,omitempty"`
	AllowedSenders []string `json:"allowed_senders,omitempty"`
}

type SendResponse struct {
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
	CFStatus int    `json:"cf_status,omitempty"`
}

func (c *Client) Auth(ctx context.Context, username, password string) (*AuthResponse, error) {
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
	return &response, nil
}

func (c *Client) Send(ctx context.Context, envelopeFrom string, recipients []string, mime []byte) (*SendResponse, error) {
	headers := map[string]string{
		"content-type":          "message/rfc822",
		"x-relay-envelope-from": envelopeFrom,
		"x-relay-recipients":    strings.Join(recipients, ","),
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

func (c *Client) sign(request *http.Request, path string, body []byte) {
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	nonce := randomNonce()
	bodySHA256 := hmacsign.SHA256Hex(body)
	signature := hmacsign.Sign(hmacsign.Input{
		Method:     request.Method,
		Path:       path,
		Timestamp:  timestamp,
		Nonce:      nonce,
		BodySHA256: bodySHA256,
		KeyID:      c.KeyID,
	}, c.Secret)

	request.Header.Set("X-Relay-Key-Id", c.KeyID)
	request.Header.Set("X-Relay-Timestamp", timestamp)
	request.Header.Set("X-Relay-Nonce", nonce)
	request.Header.Set("X-Relay-Body-SHA256", bodySHA256)
	request.Header.Set("X-Relay-Version", c.Version)
	request.Header.Set("X-Relay-Signature", signature)
}

func randomNonce() string {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(nonce[:])
}
