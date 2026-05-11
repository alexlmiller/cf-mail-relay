# gmail-mime-fixture/

Captured Gmail-originated MIME payloads. Used by:

- The **MS0 spike** to test `send_raw` integration with real Gmail-shaped data.
- Worker unit tests for MIME edge cases.
- Relay unit tests for size and 8-bit handling.

## How to capture a fixture

1. Run the disposable MS0 capture server from `relay/cmd/ms0-capture` on a public hostname with a valid TLS certificate.
2. Send a message from Gmail.
3. Capture the raw bytes from `MAIL FROM` through end-of-`DATA`.
4. Save as a `.eml` file in this directory.

See [`../../docs/ms0-spike.md`](../../docs/ms0-spike.md) for the exact runbook.

## Fixtures planned for MS0

| File | Content | Purpose |
|---|---|---|
| `plain-text.eml` | Simple plain text | Baseline |
| `html-with-image.eml` | HTML body + inline image | Multipart/related |
| `attachment-pdf-4mb.eml` | 4 MB PDF attachment, non-ASCII subject, existing DKIM-Signature | Size/DKIM-passthrough |
| `8bit-body.eml` | 8-bit Content-Transfer-Encoding | Expected to be rejected by relay |
| `long-subject-unicode.eml` | RFC 2047 encoded-word subject | Header preservation |
