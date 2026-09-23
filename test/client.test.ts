import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  VERSION,
  VerifNow,
  VerifNowAuthError,
  VerifNowConnectionError,
  VerifNowError,
  VerifNowRateLimitError,
  VerifNowRequestError,
  VerifNowResponseError,
  VerifNowServerError,
} from '../src/index.js';

const API_KEY = 'vn_test_key';

/** Builds a fetch stub that returns the given responses in order. */
function fetchReturning(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index++;
    if (next instanceof Error) throw next;
    return next.clone();
  });

  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

const VALID_EMAIL_BODY = {
  valid: true,
  message: 'Valid email address',
  normalizedValue: 'user@example.com',
  originalValue: 'USER@Example.Com',
  validationLevel: 'ADVANCED',
  emailDetails: {
    signals: {
      syntax_valid: true,
      mx_valid: true,
      typo_detected: false,
      disposable: false,
      role_based: false,
      free_provider: true,
      domain_age_days: 9000,
      mx_provider: 'google',
      mx_quality_score: 0.95,
    },
    risk_score: 12,
    risk_level: 'LOW',
    deliverability: 'DELIVERABLE',
    applied_level: 'ADVANCED',
  },
};

function client(fetchImpl: typeof globalThis.fetch, overrides = {}) {
  return new VerifNow({
    apiKey: API_KEY,
    fetch: fetchImpl,
    retry: { attempts: 2, backoffMs: 1, maxBackoffMs: 5 },
    ...overrides,
  });
}

describe('construction', () => {
  it('rejects a missing API key', () => {
    // @ts-expect-error deliberately omitting a required option
    expect(() => new VerifNow({})).toThrow(VerifNowError);
    expect(() => new VerifNow({ apiKey: '   ' })).toThrow(/API key is required/);
  });

  it('strips trailing slashes from baseUrl so the path never doubles up', async () => {
    const { impl, calls } = fetchReturning(jsonResponse(VALID_EMAIL_BODY));
    await client(impl, { baseUrl: 'https://api.example.com///' }).validateEmail('a@b.co');

    expect(calls[0]!.url).toBe('https://api.example.com/api/v1/validate/email');
  });

  it('defaults to the real API origin', async () => {
    const { impl, calls } = fetchReturning(jsonResponse(VALID_EMAIL_BODY));
    await client(impl).validateEmail('a@b.co');

    expect(calls[0]!.url).toBe('https://api.verifnow.io/api/v1/validate/email');
  });
});

describe('request shape', () => {
  it('posts the value and identifies itself as the Node SDK', async () => {
    const { impl, calls } = fetchReturning(jsonResponse(VALID_EMAIL_BODY));
    await client(impl).validateEmail('USER@Example.Com');

    const { init } = calls[0]!;
    const headers = init.headers as Record<string, string>;

    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ value: 'USER@Example.Com' }));
    expect(headers['X-API-KEY']).toBe(API_KEY);
    expect(headers['X-VerifNow-SDK']).toBe(`node/${VERSION}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('routes every rule to its own endpoint', async () => {
    const { impl, calls } = fetchReturning(jsonResponse({ valid: true }));
    const c = client(impl);

    await c.validateEmail('a@b.co');
    await c.validatePhone('+33612345678');
    await c.validateIban('FR7630006000011234567890189');
    await c.validateVat('FR12345678901');
    await c.validateNas('046454286');
    await c.validateSsn('123-45-6789');
    await c.validateNif('12345678Z');

    expect(calls.map((call) => call.url.split('/').pop())).toEqual([
      'email',
      'phone',
      'iban',
      'vat',
      'nas',
      'ssn',
      'nif',
    ]);
  });

  it('merges custom headers without letting them override auth', async () => {
    const { impl, calls } = fetchReturning(jsonResponse({ valid: true }));
    await client(impl, { headers: { 'X-Trace': 'abc', 'X-API-KEY': 'spoofed' } }).validateEmail(
      'a@b.co',
    );

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Trace']).toBe('abc');
    expect(headers['X-API-KEY']).toBe(API_KEY);
  });

  it('refuses an empty value without spending quota on it', async () => {
    const { impl, calls } = fetchReturning(jsonResponse({ valid: true }));

    await expect(client(impl).validateEmail('   ')).rejects.toThrow(VerifNowRequestError);
    expect(calls).toHaveLength(0);
  });
});

describe('response mapping', () => {
  it('maps snake_case diagnostics to camelCase and keeps the raw body', async () => {
    const { impl } = fetchReturning(jsonResponse(VALID_EMAIL_BODY));
    const result = await client(impl).validateEmail('USER@Example.Com');

    expect(result.valid).toBe(true);
    expect(result.normalizedValue).toBe('user@example.com');
    expect(result.validationLevel).toBe('ADVANCED');
    expect(result.emailDetails?.riskScore).toBe(12);
    expect(result.emailDetails?.riskLevel).toBe('LOW');
    expect(result.emailDetails?.appliedLevel).toBe('ADVANCED');
    expect(result.emailDetails?.signals?.mxValid).toBe(true);
    expect(result.emailDetails?.signals?.domainAgeDays).toBe(9000);
    expect(result.emailDetails?.signals?.mxQualityScore).toBe(0.95);
    expect(result.raw).toEqual(VALID_EMAIL_BODY);
  });

  it('leaves ADVANCED-only signals undefined at STANDARD depth', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: true,
        normalizedValue: 'user@example.com',
        validationLevel: 'STANDARD',
        emailDetails: {
          signals: { syntax_valid: true, mx_valid: true, disposable: false },
          risk_score: 20,
          deliverability: 'DELIVERABLE',
          applied_level: 'STANDARD',
        },
      }),
    );
    const result = await client(impl).validateEmail('user@example.com');

    expect(result.emailDetails?.riskScore).toBe(20);
    expect(result.emailDetails?.riskLevel).toBeUndefined();
    expect(result.emailDetails?.signals?.mxProvider).toBeUndefined();
  });

  it('normalises a missing normalizedValue to null', async () => {
    const { impl } = fetchReturning(jsonResponse({ valid: false, message: 'Invalid email format' }));
    const result = await client(impl).validateEmail('nope');

    expect(result.valid).toBe(false);
    expect(result.normalizedValue).toBeNull();
  });

  it('reads quota counters from the response headers', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    const { impl } = fetchReturning(
      jsonResponse(VALID_EMAIL_BODY, {
        headers: {
          'X-RateLimit-Limit': '250',
          'X-RateLimit-Remaining': '187',
          'X-RateLimit-Reset': String(resetAt),
          'X-Quota-Overage': 'true',
        },
      }),
    );
    const result = await client(impl).validateEmail('a@b.co');

    expect(result.quota?.limit).toBe(250);
    expect(result.quota?.remaining).toBe(187);
    expect(result.quota?.overage).toBe(true);
    expect(result.quota?.resetAt?.getTime()).toBe(resetAt * 1000);
  });

  it('maps VAT diagnostics, including the trader details', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: true,
        message: 'Valid VAT number',
        normalizedValue: 'IE6388047V',
        originalValue: 'IE6388047V',
        validationLevel: 'STANDARD',
        vatDetails: {
          format_valid: true,
          registered: true,
          country_code: 'IE',
          source: 'LIVE',
          checked_at: '2026-09-08T02:21:25Z',
          trader_name: 'GOOGLE IRELAND LIMITED',
          trader_address: '3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4',
          vies_available: true,
          consultation_number: 'WAPIAAAAX8k1abcd',
        },
      }),
    );
    const result = await client(impl).validateVat('IE6388047V');

    expect(result.vatDetails?.formatValid).toBe(true);
    expect(result.vatDetails?.registered).toBe(true);
    expect(result.vatDetails?.countryCode).toBe('IE');
    expect(result.vatDetails?.source).toBe('LIVE');
    expect(result.vatDetails?.traderName).toBe('GOOGLE IRELAND LIMITED');
    expect(result.vatDetails?.viesAvailable).toBe(true);
    expect(result.vatDetails?.consultationNumber).toBe('WAPIAAAAX8k1abcd');
    expect(result.vatDetails?.checkedAt?.toISOString()).toBe('2026-09-08T02:21:25.000Z');
  });

  it('maps US SSN diagnostics', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: false,
        message: 'That is an ITIN, not an SSN',
        normalizedValue: null,
        originalValue: '9xx-78-xxxx',
        validationLevel: 'STANDARD',
        ssnDetails: { itin: true },
      }),
    );
    const result = await client(impl).validateSsn('9xx-78-xxxx');

    expect(result.valid).toBe(false);
    expect(result.ssnDetails?.itin).toBe(true);
  });

  it('maps Spanish NIF diagnostics', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: true,
        message: 'Valid NIF',
        normalizedValue: 'B12345674',
        originalValue: 'B-12345674',
        validationLevel: 'STANDARD',
        nifDetails: {
          type: 'ENTITY',
          natural_person: false,
          checksum_valid: true,
          entity_letter: 'B',
          entity_type: 'Private limited company (Sociedad de responsabilidad limitada)',
        },
      }),
    );
    const result = await client(impl).validateNif('B-12345674');

    expect(result.nifDetails?.type).toBe('ENTITY');
    expect(result.nifDetails?.naturalPerson).toBe(false);
    expect(result.nifDetails?.checksumValid).toBe(true);
    expect(result.nifDetails?.entityLetter).toBe('B');
    expect(result.nifDetails?.entityType).toContain('Private limited company');
  });

  it('maps Canadian SIN diagnostics', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: true,
        message: 'Valid SIN format, but numbers starting with 0 are not issued to individuals',
        normalizedValue: '046454286',
        originalValue: '046 454 286',
        validationLevel: 'STANDARD',
        nasDetails: {
          checksum_valid: true,
          temporary_resident: false,
          individual_series: false,
          formatted: '046 454 286',
        },
      }),
    );
    const result = await client(impl).validateNas('046 454 286');

    expect(result.normalizedValue).toBe('046454286');
    expect(result.nasDetails?.checksumValid).toBe(true);
    expect(result.nasDetails?.temporaryResident).toBe(false);
    expect(result.nasDetails?.individualSeries).toBe(false);
    expect(result.nasDetails?.formatted).toBe('046 454 286');
  });

  it('reports an IBAN outside SEPA as valid but not collectable', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: true,
        message: 'Valid IBAN',
        normalizedValue: 'EG800000000000000000000000000',
        originalValue: 'EG800000000000000000000000000',
        validationLevel: 'STANDARD',
        ibanDetails: {
          country_code: 'EG',
          sepa: false,
          structure_valid: true,
          checksum_valid: true,
          length: 29,
          expected_length: 29,
        },
      }),
    );
    const result = await client(impl).validateIban('EG800000000000000000000000000');

    // Nothing is wrong with the number; a SEPA direct debit against it could only fail.
    expect(result.valid).toBe(true);
    expect(result.ibanDetails?.sepa).toBe(false);
  });

  it('maps IBAN diagnostics, keeping structure and checksum apart', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: false,
        message: 'A FR IBAN is 27 characters long',
        normalizedValue: null,
        originalValue: 'FR23111111111111111111111',
        validationLevel: 'STANDARD',
        ibanDetails: {
          country_code: 'FR',
          sepa: true,
          structure_valid: false,
          checksum_valid: true,
          length: 25,
          expected_length: 27,
        },
      }),
    );
    const result = await client(impl).validateIban('FR23111111111111111111111');

    // Valid check digits, impossible length: the distinction the two fields exist to carry.
    expect(result.valid).toBe(false);
    expect(result.ibanDetails?.checksumValid).toBe(true);
    expect(result.ibanDetails?.structureValid).toBe(false);
    expect(result.ibanDetails?.countryCode).toBe('FR');
    expect(result.ibanDetails?.length).toBe(25);
    expect(result.ibanDetails?.expectedLength).toBe(27);
    expect(result.ibanDetails?.formatted).toBeUndefined();
    expect(result.ibanDetails?.sepa).toBe(true);
  });

  it('maps phone diagnostics', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: true,
        message: 'Valid phone number',
        normalizedValue: '+33612345678',
        originalValue: '+33 6 12 34 56 78',
        validationLevel: 'STANDARD',
        phoneDetails: {
          country_code: 'FR',
          calling_code: 33,
          line_type: 'MOBILE',
          international_format: '+33 6 12 34 56 78',
          national_format: '06 12 34 56 78',
        },
      }),
    );
    const result = await client(impl).validatePhone('+33 6 12 34 56 78');

    expect(result.normalizedValue).toBe('+33612345678');
    expect(result.phoneDetails?.countryCode).toBe('FR');
    expect(result.phoneDetails?.callingCode).toBe(33);
    expect(result.phoneDetails?.lineType).toBe('MOBILE');
    expect(result.phoneDetails?.internationalFormat).toBe('+33 6 12 34 56 78');
    expect(result.phoneDetails?.nationalFormat).toBe('06 12 34 56 78');
  });

  it('keeps registered:null distinct from registered:false', async () => {
    // The distinction this whole type exists to carry. `false` means the registry answered and
    // the number is not there; `null` means VIES could not be asked. A caller that cannot tell
    // them apart rejects legitimate businesses during someone else's outage.
    const unverified = fetchReturning(
      jsonResponse({
        valid: true,
        normalizedValue: 'FR12345678901',
        validationLevel: 'STANDARD',
        vatDetails: {
          format_valid: true,
          registered: null,
          country_code: 'FR',
          source: 'UNVERIFIED',
          vies_available: false,
        },
      }),
    );
    const unknown = await client(unverified.impl).validateVat('FR12345678901');

    expect(unknown.vatDetails?.registered).toBeNull();
    expect(unknown.vatDetails?.registered).not.toBe(false);
    expect(unknown.vatDetails?.source).toBe('UNVERIFIED');

    const absent = fetchReturning(
      jsonResponse({
        valid: false,
        validationLevel: 'STANDARD',
        vatDetails: {
          format_valid: true,
          registered: false,
          country_code: 'FR',
          source: 'CACHE',
          vies_available: true,
        },
      }),
    );
    const notRegistered = await client(absent.impl).validateVat('FR12345678901');

    expect(notRegistered.vatDetails?.registered).toBe(false);
  });

  it('reads a vatDetails without a registered key as unknown, not as unregistered', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: true,
        validationLevel: 'STANDARD',
        vatDetails: { format_valid: true, country_code: 'DE', source: 'UNVERIFIED' },
      }),
    );
    const result = await client(impl).validateVat('DE811907980');

    expect(result.vatDetails?.registered).toBeNull();
  });

  it('leaves vatDetails undefined on a non-VAT validation', async () => {
    const { impl } = fetchReturning(jsonResponse(VALID_EMAIL_BODY));
    const result = await client(impl).validateEmail('user@example.com');

    expect(result.vatDetails).toBeUndefined();
  });

  it('ignores an unparseable checked_at rather than producing an Invalid Date', async () => {
    const { impl } = fetchReturning(
      jsonResponse({
        valid: true,
        validationLevel: 'STANDARD',
        vatDetails: { format_valid: true, registered: true, checked_at: 'not-a-date' },
      }),
    );
    const result = await client(impl).validateVat('IE6388047V');

    expect(result.vatDetails?.checkedAt).toBeUndefined();
  });

  it('rejects a success status carrying a non-JSON body', async () => {
    const { impl } = fetchReturning(new Response('<html>gateway</html>', { status: 200 }));

    await expect(client(impl).validateEmail('a@b.co')).rejects.toThrow(VerifNowResponseError);
  });
});

describe('errors', () => {
  it('raises an auth error on 401 and does not retry it', async () => {
    const { impl, calls } = fetchReturning(
      jsonResponse({ status: 401, message: 'Invalid API key' }, { status: 401 }),
    );

    await expect(client(impl).validateEmail('a@b.co')).rejects.toThrow(VerifNowAuthError);
    expect(calls).toHaveLength(1);
  });

  it('raises a request error on 400 and does not retry it', async () => {
    const { impl, calls } = fetchReturning(
      jsonResponse({ status: 400, message: 'Value is required' }, { status: 400 }),
    );

    await expect(client(impl).validateEmail('a@b.co')).rejects.toThrow(VerifNowRequestError);
    expect(calls).toHaveLength(1);
  });

  it('surfaces quota state on a 429', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 86_400;
    const { impl } = fetchReturning(
      jsonResponse({ message: 'Rate limit exceeded' }, {
        status: 429,
        headers: {
          'X-RateLimit-Limit': '250',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(resetAt),
        },
      }),
    );

    const error = await client(impl)
      .validateEmail('a@b.co')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VerifNowRateLimitError);
    const rateLimit = error as VerifNowRateLimitError;
    expect(rateLimit.quota?.remaining).toBe(0);
    expect(rateLimit.retryAfterSeconds).toBeGreaterThan(80_000);
  });

  it('extracts the message from a plain-text error body', async () => {
    const { impl } = fetchReturning(
      new Response('Rate limit exceeded. Please upgrade your plan.', { status: 429 }),
    );

    await expect(client(impl).validateEmail('a@b.co')).rejects.toThrow(/upgrade your plan/);
  });

  it('names the URL it could not reach, so a wrong baseUrl is obvious', async () => {
    const { impl } = fetchReturning(new TypeError('fetch failed'));
    const c = client(impl, { baseUrl: 'https://api.verifnow.com' });

    const error = await c.validateEmail('a@b.co').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VerifNowConnectionError);
    expect((error as Error).message).toContain('https://api.verifnow.com/api/v1/validate/email');
  });

  it('never reports a value as valid when the API is unreachable', async () => {
    const { impl } = fetchReturning(new TypeError('fetch failed'));

    // The Java SDK's fail-open default returns valid=true here. This one must not.
    await expect(client(impl).validateEmail('definitely-not-an-email')).rejects.toThrow(
      VerifNowConnectionError,
    );
  });

  it('reports a timeout distinctly from a transport failure', async () => {
    const slowFetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof globalThis.fetch;

    const error = await client(slowFetch, { timeoutMs: 10, retry: false })
      .validateEmail('a@b.co')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VerifNowConnectionError);
    expect((error as VerifNowConnectionError).timedOut).toBe(true);
  });

  it("propagates the caller's own cancellation untouched", async () => {
    const controller = new AbortController();
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof globalThis.fetch;

    const promise = client(hangingFetch, { retry: false }).validateEmail('a@b.co', {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/);
  });
});

describe('retries', () => {
  it('retries a 500 and returns the eventual success', async () => {
    const { impl, calls } = fetchReturning(
      jsonResponse({ message: 'boom' }, { status: 500 }),
      jsonResponse(VALID_EMAIL_BODY),
    );

    const result = await client(impl).validateEmail('a@b.co');

    expect(result.valid).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries a connection failure', async () => {
    const { impl, calls } = fetchReturning(
      new TypeError('fetch failed'),
      jsonResponse(VALID_EMAIL_BODY),
    );

    await client(impl).validateEmail('a@b.co');
    expect(calls).toHaveLength(2);
  });

  it('gives up after the configured number of attempts', async () => {
    const { impl, calls } = fetchReturning(jsonResponse({ message: 'boom' }, { status: 500 }));

    await expect(client(impl).validateEmail('a@b.co')).rejects.toThrow(VerifNowServerError);
    expect(calls).toHaveLength(3); // 1 initial + 2 retries
  });

  it('retries a 429 whose reset is imminent', async () => {
    const { impl, calls } = fetchReturning(
      jsonResponse({ message: 'concurrency' }, { status: 429, headers: { 'Retry-After': '0' } }),
      jsonResponse(VALID_EMAIL_BODY),
    );

    await client(impl).validateEmail('a@b.co');
    expect(calls).toHaveLength(2);
  });

  it('does not sleep on a 429 whose quota resets days from now', async () => {
    const { impl, calls } = fetchReturning(
      jsonResponse({ message: 'quota' }, { status: 429, headers: { 'Retry-After': '86400' } }),
    );

    await expect(client(impl).validateEmail('a@b.co')).rejects.toThrow(VerifNowRateLimitError);
    expect(calls).toHaveLength(1);
  });

  it('honours retry: false', async () => {
    const { impl, calls } = fetchReturning(jsonResponse({ message: 'boom' }, { status: 500 }));

    await expect(client(impl, { retry: false }).validateEmail('a@b.co')).rejects.toThrow(
      VerifNowServerError,
    );
    expect(calls).toHaveLength(1);
  });
});

describe('packaging', () => {
  it('keeps VERSION in sync with package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(VERSION).toBe(pkg.version);
  });
});

describe('VAT rates', () => {
  const FRANCE = {
    countryCode: 'FR',
    standardRate: 20,
    reducedRates: [2.1, 5.5, 10],
    regionalRates: [
      { rate: 8.5, note: 'The standard VAT rate in Martinique, Guadeloupe and Réunion is 8.5%.' },
      { rate: 13, note: 'For Corsica: rate of 13% on oil products.' },
    ],
    situationOn: '2026-07-01',
    fetchedAt: '2026-09-23T02:52:37Z',
  };

  it('reads one member state with a GET and no body', async () => {
    const { impl, calls } = fetchReturning(jsonResponse(FRANCE));

    const rates = await client(impl).vatRate('fr');

    expect(calls[0]!.url).toBe('https://api.verifnow.io/api/v1/vat/rates/fr');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
    // No body, so no Content-Type claiming one.
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();

    expect(rates.countryCode).toBe('FR');
    expect(rates.standardRate).toBe(20);
    expect(rates.reducedRates).toEqual([2.1, 5.5, 10]);
    expect(rates.regionalRates.map((r) => r.rate)).toEqual([8.5, 13]);
    expect(rates.regionalRates[1]!.note).toMatch(/^For Corsica/);
    // A date without a time zone stays a string: new Date('2026-07-01') is 30 June in the Americas.
    expect(rates.situationOn).toBe('2026-07-01');
    expect(rates.fetchedAt).toEqual(new Date('2026-09-23T02:52:37Z'));
  });

  it('reads every member state', async () => {
    const { impl, calls } = fetchReturning(
      jsonResponse({
        source: 'TEDB',
        sourceUrl: 'https://ec.europa.eu/taxation_customs/tedb/',
        countries: 2,
        rates: [
          { ...FRANCE },
          { countryCode: 'DK', standardRate: 25, reducedRates: [], regionalRates: [], situationOn: '2026-07-01' },
        ],
      }),
    );

    const all = await client(impl).vatRates();

    expect(calls[0]!.url).toBe('https://api.verifnow.io/api/v1/vat/rates');
    expect(all.source).toBe('TEDB');
    expect(all.rates.map((r) => r.countryCode)).toEqual(['FR', 'DK']);
    // Denmark has no reduced rate — an empty list, not a 0.
    expect(all.rates[1]!.reducedRates).toEqual([]);
  });

  it('escapes the country code into the path', async () => {
    const { impl, calls } = fetchReturning(jsonResponse(FRANCE));

    await client(impl).vatRate(' F/R ');

    expect(calls[0]!.url).toBe('https://api.verifnow.io/api/v1/vat/rates/F%2FR');
  });

  it('turns a country outside the union into a request error, not a retry', async () => {
    const { impl, calls } = fetchReturning(
      jsonResponse(
        { status: 404, message: 'Not an EU member state: US. VAT rates are published for the 27 member states; Greece is EL.' },
        { status: 404 },
      ),
    );

    await expect(client(impl).vatRate('US')).rejects.toMatchObject({
      name: 'VerifNowRequestError',
      status: 404,
    });
    await expect(client(impl).vatRate('US')).rejects.toThrow(/Not an EU member state: US/);
    // 404 answers the same the second time; retrying would only spend time.
    expect(calls).toHaveLength(2);
  });

  it('retries a 503 while the first snapshot is being retrieved', async () => {
    const { impl, calls } = fetchReturning(
      jsonResponse({ status: 503, message: 'VAT rates have not been retrieved from TEDB yet' }, { status: 503 }),
      jsonResponse(FRANCE),
    );

    const rates = await client(impl).vatRate('FR');

    expect(calls).toHaveLength(2);
    expect(rates.standardRate).toBe(20);
  });

  it('rejects an empty country code without calling the API', async () => {
    const { impl, calls } = fetchReturning(jsonResponse(FRANCE));

    await expect(client(impl).vatRate('  ')).rejects.toBeInstanceOf(VerifNowRequestError);
    expect(calls).toHaveLength(0);
  });
});
