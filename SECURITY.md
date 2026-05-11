# Security Policy

## Reporting a vulnerability

Email **security@alexmiller.net** with the details. Do **not** open a public issue.

Please include:

- A description of the vulnerability.
- Steps to reproduce, or a minimal proof-of-concept.
- The component affected (`relay/`, `worker/`, `ui/`, `shared/`, `infra/`).
- The commit SHA or release tag you tested against.
- Whether you would like credit in the disclosure.

You should receive an acknowledgement within 72 hours and an initial assessment within 7 days.

## Scope

In scope:

- Authentication bypass on the relay (`/relay/auth`, SMTP AUTH flow).
- Authentication or authorisation bypass on the Worker (`/relay/*`, `/send`, `/admin/api/*`).
- Open relay behaviour (delivering mail without authentication or outside the allowlist).
- HMAC verification flaws, replay protection failures.
- Cloudflare Access JWT verification flaws.
- Credential or secret leakage in logs, error messages, or D1 columns.
- DKIM/DMARC alignment failures that allow spoofing through this relay.
- Idempotency-key collisions that allow duplicate sends or replay of a stored response across credentials.

Out of scope:

- Adopter misconfiguration (e.g., publishing DNS records incorrectly, orange-clouding `smtp.<domain>`, leaving Email Sending in sandbox mode).
- Cloudflare platform behaviour outside this codebase's control.
- Denial-of-service against the adopter's own Cloudflare account (rate limits, Worker invocation budget).
- Issues that require a compromised relay host. The relay host is trusted
  infrastructure; rotate relay HMAC and SMTP credentials if it is compromised.

## Coordinated disclosure

Please give us a reasonable window to fix and release before any public disclosure. Standard practice is 90 days, shorter if the fix lands sooner.
