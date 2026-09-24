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

## VAT and VIES

VAT is the one validator whose answer can be *unknown* rather than yes or no. Registration is
checked against VIES, the European Commission's registry, which publishes no SLA and drops member
states several times a month.

```ts
const result = await client.validateVat('IE6388047V');
const vat = result.vatDetails!;

vat.formatValid;   // true — structural, decided locally, never depends on VIES
vat.registered;    // true | false | null
vat.source;        // 'LIVE' | 'CACHE' | 'STALE' | 'UNVERIFIED' | 'NOT_APPLICABLE'
vat.traderName;    // 'GOOGLE IRELAND LIMITED' — when the member state discloses it
```

**`registered: null` means unknown, never "not registered."** It is what you get when VIES could
not be consulted. Treating it as `false` rejects legitimate businesses during someone else's
outage:

```ts
if (!vat.formatValid) return reject('That VAT number is not correctly formed.');
if (vat.registered === false) return reject('That VAT number is not registered.');

if (vat.registered === null) {
  // Accept, record that it is unconfirmed, and re-check later.
  await queueForRecheck(vatNumber);
  return accept({ verified: false });
}

return accept({ verified: true, stale: vat.source === 'STALE' });
```

### Does the number belong to this company?

Pass the name you expect — from a supplier form, for instance — and the response says whether it
matches the registered holder:

```ts
const result = await client.validateVat('ESA28015865', { traderName: 'Telefonica' });

result.vatDetails?.traderNameMatch;        // 'MATCH' | 'MISMATCH' | 'NOT_AVAILABLE'
result.vatDetails?.traderNameMatchSource;  // 'VERIFNOW' | 'VIES'
```

Who compares depends on the member state. Where VIES publishes the holder's name (most of them),
VerifNow compares, ignoring case, accents, punctuation and legal forms. Spain publishes no name but
has VIES check one. Germany does neither, and the answer is `NOT_AVAILABLE` rather than a guess. A
`MISMATCH` is a question for a human, not proof of fraud.

Per-country VIES availability is public and needs no API key:
[`GET /api/v1/status/vies`](https://www.verifnow.io/en/status).

### VAT rates

The rates of the 27 member states, retrieved daily from the Commission's
[TEDB](https://ec.europa.eu/taxation_customs/tedb/). Public reference data: these calls spend no
quota.

```ts
const france = await client.vatRate('FR');   // GR is accepted for Greece (EL)

france.standardRate;    // 20
france.reducedRates;    // [2.1, 5.5, 10] — which one applies depends on the product
france.regionalRates;   // [{ rate: 8.5, note: 'The standard VAT rate in Martinique, …', euVatArea: false }, …]
france.situationOn;     // '2026-07-01' — the date TEDB says these rates apply from
france.fetchedAt;       // Date — when VerifNow last retrieved them

const all = await client.vatRates();         // all.rates: one entry per member state
```

`euVatArea: false` marks the Canary Islands and the French overseas territories, which the VAT
Directive excludes: goods shipped there from another member state are an export, not a distance
sale at that rate.

**These are the rates a member state has, not the rate an invoice carries.** In B2B trade between
member states the invoice is usually zero-rated under the reverse charge, whatever the buyer's
country rate is. Multiplying an amount by the buyer's standard rate is wrong in exactly the case a
VAT number is collected for.

## Validators

```ts
await client.validateEmail('user@example.com');
await client.validatePhone('+33612345678');
await client.validateIban('FR7630006000011234567890189');
await client.validateVat('FR12345678901');
await client.validateNas('046454286');       // Canadian Social Insurance Number
await client.validateSsn(form.ssn);          // US Social Security Number — never commit a real one
await client.validateNif('B12345674');       // Spanish NIF — DNI, NIE or company

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
  vatDetails?: VatDetails;         // VAT only
  phoneDetails?: PhoneDetails;     // phone only — country, lineType, formats
  ibanDetails?: IbanDetails;       // IBAN only — structure, checksum and SEPA scope
  nasDetails?: NasDetails;         // Canadian SIN only — temporary resident, series
  nifDetails?: NifDetails;         // Spanish NIF only — DNI, NIE or company, legal form
  ssnDetails?: SsnDetails;         // US SSN only — whether the number is an ITIN
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
