# Security policy

## Supported versions

Security fixes are published for the latest stable `1.x` release.

## Report a vulnerability

Email **security@alexmiller.net**. Do not open a public issue. Include the
affected component, release tag or commit, impact, and reproduction steps. Say
whether you want disclosure credit.

Expect acknowledgement within 72 hours and an initial assessment within seven
days. Please allow a reasonable fix window before disclosure; 90 days is the
default when severity does not require faster coordination.

## In scope

- Auth or authorization bypass in SMTP, `/relay/*`, `/send`,
  `/bootstrap/admin`, `/admin/api/*`, or `/self/api/*`.
- Open-relay behavior or sender-policy bypass.
- HMAC, replay, idempotency, Access JWT, Origin, quota, or rate-limit bypass.
- Credential, secret, message, recipient, or provider-response leakage beyond
  the documented metadata model.
- DKIM/DMARC spoofing enabled by this project.
- Dependency, build, release, demo, or deployment-chain compromise.

## Out of scope

- Cloudflare behavior outside this codebase.
- Adopter DNS, Access, certificate, token, or relay-host misconfiguration.
- Volumetric denial of service against providers or account budgets.
- Findings that require an already compromised trusted relay host.
- Social engineering, physical attacks, or compromised administrator devices.
- Demo/sample-data findings with no production impact.

## Security model

The service is send-only and does not persist bodies, subjects, attachments, or
recipient addresses itself. Cloudflare Email Preview may retain sent content
separately. D1 stores configuration, hashes, quotas, idempotency, and sanitized
audit metadata. The relay uses HMAC, `/send` uses scoped API keys, and admin/self
APIs use Cloudflare Access. See the
[trust boundaries](docs/architecture.md#trust-boundaries).
