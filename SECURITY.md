# Security Policy

## Supported versions

Security fixes are published for the latest stable release. Before `1.0.0`,
report issues against `main` or the current release candidate.

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
- Message body, subject, attachment, recipient-address, or provider-response
  leakage beyond the documented metadata model.
- DKIM/DMARC alignment failures that allow spoofing through this relay.
- Idempotency-key collisions that allow duplicate sends or replay of a stored response across credentials.
- Dependency, release, or deployment-chain issues that could compromise the
  Worker, relay container, demo Worker, or published artifacts.

Out of scope:

- Adopter misconfiguration (e.g., publishing DNS records incorrectly, orange-clouding `smtp.<domain>`, leaving Email Sending in sandbox mode).
- Cloudflare platform behaviour outside this codebase's control.
- Volumetric denial-of-service against Cloudflare, GitHub, npm, or an adopter's
  own Cloudflare account budget. Application-level rate-limit bypasses are in
  scope.
- Issues that require a compromised relay host. The relay host is trusted
  infrastructure; rotate relay HMAC and SMTP credentials if it is compromised.
- Social engineering, physical attacks, or compromised administrator devices.
- Vulnerabilities in demo/sample data that do not affect the production Worker,
  relay, setup tooling, or release artifacts.

## Security model

CF Mail Relay is send-only. It should not store message bodies, subjects, or
attachment contents. D1 stores operational metadata, credential hashes,
configuration, audit rows, idempotency records, and quota counters. Provider
responses and idempotency replay bodies are expected to be sanitized before
storage.

The admin and sender self-service APIs are protected by Cloudflare Access. The
SMTP relay authenticates to the Worker with HMAC, and the HTTP `/send` endpoint
uses bearer API keys. Report any path that can send mail or mutate state without
the relevant authentication boundary.

## Coordinated disclosure

Please give us a reasonable window to fix and release before any public disclosure. Standard practice is 90 days, shorter if the fix lands sooner.
