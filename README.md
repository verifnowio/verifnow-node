# VerifNow Node.js SDK

[![npm](https://img.shields.io/npm/v/@verifnow/sdk.svg)](https://www.npmjs.com/package/@verifnow/sdk)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Official Node.js SDK for the [VerifNow](https://www.verifnow.io) validation API. One API key for
email, phone, IBAN, VAT, SSN, SIN and NIF validation.

TypeScript-first, no runtime dependencies, ESM and CommonJS.

## Install

```bash
npm install @verifnow/sdk
```

Requires Node 18 or later (the SDK uses the built-in `fetch`). Works in any runtime that provides
a WHATWG `fetch`, including Deno, Bun, and edge runtimes.

## Getting an API key

1. Create an account at [app.verifnow.io](https://app.verifnow.io).
2. Create an API key from the dashboard.
3. Keep it server-side. It authorises calls against your quota — never ship it to a browser.

The Free plan gives you 250 validations a month with the full `STANDARD` check set, no credit card.

## Quick start

```ts
import { VerifNow } from '@verifnow/sdk';

const client = new VerifNow({ apiKey: process.env.VERIFNOW_API_KEY! });

const result = await client.validateEmail('user@exmaple.com');

console.log(result.valid);            // false
console.log(result.message);          // "Email address is unlikely to be deliverable"
console.log(result.normalizedValue);  // null when invalid

// Turn a typo into a correction prompt instead of a rejection
const signals = result.emailDetails?.signals;
if (signals?.typoDetected) {
  console.log(`Did you mean ${signals.suggestedDomain}?`); // "example.com"
}
```

## Validators

```ts
await client.validateEmail('user@example.com');
await client.validatePhone('+33612345678');
await client.validateIban('FR7630006000011234567890189');
await client.validateVat('FR12345678901');
await client.validateNas('046454286');       // Canadian Social Insurance Number
await client.validateSsn('123-45-6789');     // US Social Security Number
await client.validateNif('12345678Z');       // Spanish / Portuguese NIF

// When the rule is only known at runtime
await client.validate('iban', value);
```

Every call returns the same `ValidationResult` shape:

```ts
interface ValidationResult {
  valid: boolean;
  message?: string;
  normalizedValue: string | null;  // canonical form, null when invalid
  originalValue?: string;
  validationLevel?: ValidationLevel;
  emailDetails?: EmailDetails;     // email only
  quota?: QuotaInfo;               // from the X-RateLimit-* headers
  raw: Record<string, unknown>;    // untouched response body
}
```

## Email signals and your plan

Email validation returns a per-signal breakdown. **Which signals are present depends on your
plan**, so branch on `appliedLevel` rather than assuming a field exists:

| Signal | STANDARD (Free, Starter) | ADVANCED (Growth) | PREMIUM (Pro) |
|--------|:------------------------:|:-----------------:|:-------------:|
| `syntaxValid`, `mxValid` | ✅ | ✅ | ✅ |
| `typoDetected`, `suggestedDomain` | ✅ | ✅ | ✅ |
| `roleBased`, `disposable` | ✅ | ✅ | ✅ |
| `riskScore` (0–100), `deliverability` | ✅ | ✅ | ✅ |
| `freeProvider`, `domainAgeDays` | ❌ | ✅ | ✅ |
| `mxProvider`, `mxQualityScore` | ❌ | ✅ | ✅ |
| `riskLevel` (LOW/MEDIUM/HIGH) | ❌ | ✅ | ✅ |

```ts
const { emailDetails } = await client.validateEmail(input);

if (emailDetails?.appliedLevel === 'ADVANCED' || emailDetails?.appliedLevel === 'PREMIUM') {
  if (emailDetails.riskLevel === 'HIGH') return reject();
}

// riskScore is available on every plan
if ((emailDetails?.riskScore ?? 0) > 70) return flagForReview();
```

## Error handling

**This SDK throws when it cannot reach the API. It never reports an unverified value as valid.**
A validation client that swallows an outage and answers `valid: true` turns downtime into silently
accepted bad data, and you find out months later. Deciding to accept input during an outage is
reasonable — it should just be your decision, written down:

```ts
import {
  VerifNow,
  VerifNowAuthError,
  VerifNowConnectionError,
  VerifNowRateLimitError,
  VerifNowRequestError,
} from '@verifnow/sdk';

try {
  const result = await client.validateEmail(input);
  return result.valid;
} catch (error) {
  if (error instanceof VerifNowAuthError) {
    throw error;                    // misconfiguration — fix it, do not degrade
  }
  if (error instanceof VerifNowRateLimitError) {
    logger.warn({ resetAt: error.quota?.resetAt }, 'VerifNow quota exhausted');
    return true;                    // deliberate: accept rather than block signups
  }
  if (error instanceof VerifNowConnectionError) {
    logger.error({ error }, 'VerifNow unreachable, accepting unverified');
    return true;
  }
  throw error;
}
```

| Error | Raised on | Retried |
|-------|-----------|:-------:|
| `VerifNowRequestError` | 400 — malformed payload, empty value | no |
| `VerifNowAuthError` | 401 / 403 — key missing, invalid or revoked | no |
| `VerifNowRateLimitError` | 429 — monthly quota or concurrency limit | only if the reset is imminent |
| `VerifNowServerError` | 5xx | yes |
| `VerifNowConnectionError` | DNS, TLS, refused connection, timeout | yes |
| `VerifNowResponseError` | 2xx with an unparseable body | no |

All extend `VerifNowError` and carry `status` and `requestId` where available.
`VerifNowRateLimitError` adds `quota` and `retryAfterSeconds`.

## Quota

Every successful response carries the quota counters:

```ts
const { quota } = await client.validateEmail(input);

console.log(quota?.remaining); // 187
console.log(quota?.limit);     // 250
console.log(quota?.resetAt);   // Date — start of the next billing period
console.log(quota?.overage);   // true once you are billed per unit
```

Paid plans are never cut off: past the included quota, extra requests are billed per unit and
`overage` flips to `true`. The Free plan blocks at its limit with a 429.

## Configuration

```ts
const client = new VerifNow({
  apiKey: process.env.VERIFNOW_API_KEY!,  // required
  baseUrl: 'https://api.verifnow.io',     // default
  timeoutMs: 5000,                        // default, per attempt
  retry: {
    attempts: 2,                          // default — up to 3 requests in total
    backoffMs: 200,                       // default, doubles each attempt
    maxBackoffMs: 2000,                   // default
  },
  headers: { 'X-Trace-Id': traceId },      // merged into every request
  fetch: customFetch,                     // defaults to globalThis.fetch
});
```

Pass `retry: false` to disable retries. Per-call overrides:

```ts
await client.validateEmail(input, { timeoutMs: 1000, signal: controller.signal });
```

A signal you pass is combined with the timeout, and your own cancellation propagates untouched
rather than being wrapped as a connection failure.

## Validating at the edge of your app

Validate on the server, at the boundary where data enters — not in the browser, which would expose
your API key and can be bypassed:

```ts
// app/api/signup/route.ts
import { VerifNow, VerifNowError } from '@verifnow/sdk';

const verifnow = new VerifNow({ apiKey: process.env.VERIFNOW_API_KEY! });

export async function POST(request: Request) {
  const { email } = await request.json();

  try {
    const result = await verifnow.validateEmail(email);

    if (!result.valid) {
      const suggestion = result.emailDetails?.signals?.suggestedDomain;
      return Response.json(
        { error: result.message, suggestion },
        { status: 422 },
      );
    }

    await createAccount(result.normalizedValue!); // store the canonical form
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof VerifNowError) {
      console.error('VerifNow unavailable', error);
      await createAccount(email); // accept unverified rather than block the signup
      return Response.json({ ok: true, verified: false });
    }
    throw error;
  }
}
```

Reuse one client across requests — it holds no per-request state.

## Other SDKs

- **Java / Spring**: [`io.verifnow:verifnow-spring-boot-starter`](https://central.sonatype.com/artifact/io.verifnow/verifnow-spring-boot-starter)

## Documentation

- API reference and guides: [docs.verifnow.io](https://docs.verifnow.io)
- Pricing and plans: [verifnow.io/pricing](https://www.verifnow.io/en/pricing)

## License

Apache-2.0
