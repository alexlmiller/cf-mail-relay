# shared/

TypeScript types, zod schemas, and HMAC test vectors used by both `worker/` and `ui/`.

CI fails on contract drift: the same zod schemas are imported by both consumers, and round-trip tests run in both packages.

## Status

Scaffold only.

## Contents (planned)

- `src/types.ts` — shared TypeScript interfaces (User, Domain, Credential, SendEvent, etc.).
- `src/schemas.ts` — zod schemas matching D1 row shapes and HTTP API contracts.
- `src/smtp-error-map.ts` — the SMTP-code mapping table from `IMPLEMENTATION_PLAN.md`.
- `test-vectors.json` — canonical HMAC inputs and expected signatures. Consumed by both `worker/` (TS HMAC verifier) and `relay/` (Go HMAC signer) tests.
