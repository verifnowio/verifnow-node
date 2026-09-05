# CLAUDE.md — VerifNow Node.js SDK

Guidance for Claude Code (claude.ai/code) when working in this repository.

Published as **`@verifnow/sdk`** on npm. The plain name `verifnow` on npm belongs to an unrelated
package, so the scoped name is not a preference — it is the only one available.

## What this package is for

It is an acquisition channel as much as a convenience. npm has its own search, its own package
page, and developers judge an API by how its SDK reads. A broken or unconvincing SDK costs more
than no SDK.

The API surface covers all seven validators — email, phone, IBAN, VAT, SSN, SIN (NAS), NIF — because
the whole positioning is "one key for every field your billing and onboarding forms check". An SDK
that only exposes email would contradict the product.

## Non-negotiables

- **Zero runtime dependencies.** Anything added here is added to every user's install and audit.
- **ESM + CJS, both built by `tsup`**, with types. Dropping either breaks a real class of users.
- **Node >= 18**, so `fetch` is built in — this is what keeps the dependency count at zero.
- **Never fail open.** A validation error must throw or return an explicit failure, never a value
  that looks valid. The Java SDK shipped a default that failed open on network errors combined with
  a wrong default host: every call failed, then returned `valid=true`, and applications following
  the README validated nothing while appearing to work. That bug reached Maven Central. Do not
  reinvent it here.
- **`version.ts` is sent as `X-VerifNow-SDK: node/<version>`** on every request, which is how
  API-side usage is attributed per SDK version. It must match `package.json` — bump both together.

## Commands

```bash
npm ci
npm test          # vitest, no network — the API is mocked
npm run typecheck
npm run build     # tsup, ESM + CJS + d.ts
```

`prepublishOnly` runs typecheck, tests and build. Never publish around it.

## Conventions

- Errors are typed and carry the HTTP status and the API's message. A caller must be able to tell a
  bad input from a quota problem from an outage without parsing strings.
- Retry policy lives in `#retryDelay` and encodes a judgement worth preserving: 5xx and connection
  failures back off and retry; 400 and 401 never do, because they answer identically the second
  time; a **429 is retried only when its reset is close** — a concurrency limit clears in
  milliseconds, a spent monthly quota does not, and sleeping on it helps nobody.
- Public API changes follow semver strictly. This package is installed by other people's builds.
- Tests mock `fetch`; nothing in this suite touches the network, so it stays fast and deterministic.

## Related

- API: `validAPI` — the endpoints this wraps, and the source of truth for response shapes
- Java equivalent: `verifnow-spring` (`io.verifnow:verifnow-spring` on Maven Central)
- Docs site: `verifnow-doc` — SDK snippets there must stay in sync with this package's real API
