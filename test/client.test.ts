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
