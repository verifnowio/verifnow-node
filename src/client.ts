import {
  VerifNowAuthError,
  VerifNowConnectionError,
  VerifNowError,
  VerifNowRateLimitError,
  VerifNowRequestError,
  VerifNowResponseError,
  VerifNowServerError,
} from './errors.js';
import type {
  EmailDetails,
  EmailSignals,
  QuotaInfo,
  RetryOptions,
  ValidationResult,
  ValidationRule,
  VatDetails,
  VerifNowOptions,
} from './types.js';
import { VERSION } from './version.js';

const DEFAULT_BASE_URL = 'https://api.verifnow.io';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY: Required<RetryOptions> = {
  attempts: 2,
  backoffMs: 200,
  maxBackoffMs: 2_000,
};

/** Per-call overrides. */
export interface RequestOptions {
  /** Override the client timeout for this call. */
  timeoutMs?: number;
  /** Cancel the call from your own controller. Combined with the timeout. */
  signal?: AbortSignal;
}

/**
 * Client for the VerifNow validation API.
 *
 * @example
 * ```ts
 * import { VerifNow } from '@verifnow/sdk';
 *
 * const client = new VerifNow({ apiKey: process.env.VERIFNOW_API_KEY! });
 * const result = await client.validateEmail('user@example.com');
 *
 * if (!result.valid) console.log(result.message);
 * if (result.emailDetails?.signals?.typoDetected) {
 *   console.log('Did you mean', result.emailDetails.signals.suggestedDomain);
 * }
 * ```
 */
export class VerifNow {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retry: Required<RetryOptions> | null;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: VerifNowOptions) {
    if (!options?.apiKey || options.apiKey.trim() === '') {
      throw new VerifNowError(
        'A VerifNow API key is required. Create one in the dashboard and pass it as `apiKey`.',
      );
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new VerifNowError(
        'No global fetch available. Use Node 18 or later, or pass a `fetch` implementation.',
      );
    }

    this.#apiKey = options.apiKey.trim();
    // Trailing slashes would produce `//api/v1/...`, which some proxies reject.
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retry =
      options.retry === false ? null : { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
    this.#headers = options.headers ?? {};
    this.#fetch = fetchImpl.bind(globalThis);
  }

  /** Validate an email address: syntax, DNS/MX, typo, disposable, role-based, quality score. */
  validateEmail(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('email', value, options);
  }

  /** Validate a phone number in international format. */
  validatePhone(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('phone', value, options);
  }

  /** Validate an IBAN: country structure and check digits. */
  validateIban(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('iban', value, options);
  }

  /** Validate a VAT number. */
  validateVat(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('vat', value, options);
  }

  /** Validate a Canadian Social Insurance Number. */
  validateNas(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('nas', value, options);
  }

  /** Validate a US Social Security Number. */
  validateSsn(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('ssn', value, options);
  }

  /** Validate a Spanish/Portuguese NIF. */
  validateNif(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('nif', value, options);
  }

  /**
   * Validate a value against any rule.
   *
   * The typed helpers above call this. Use it directly when the rule is chosen at runtime.
   */
  async validate(
    rule: ValidationRule,
    value: string,
    options: RequestOptions = {},
  ): Promise<ValidationResult> {
    if (typeof value !== 'string' || value.trim() === '') {
      // Caught here rather than server-side: an empty value consumes quota and can only fail.
      throw new VerifNowRequestError(
        `Cannot validate an empty value for rule "${rule}".`,
      );
    }

    const url = `${this.#baseUrl}/api/v1/validate/${rule}`;
    const body = JSON.stringify({ value });
    const maxAttempts = this.#retry ? this.#retry.attempts + 1 : 1;

    let lastError: VerifNowError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.#requestOnce(url, body, options);
      } catch (error) {
        if (!(error instanceof VerifNowError)) throw error;
        lastError = error;

        const isLastAttempt = attempt === maxAttempts - 1;
        if (isLastAttempt || !this.#retry) throw error;

        const delay = this.#retryDelay(error, attempt);
        if (delay === null) throw error;

        await sleep(delay);
      }
    }

    /* c8 ignore next -- the loop either returns or throws */
    throw lastError ?? new VerifNowError('Request failed');
  }

  /**
   * How long to wait before retrying, or `null` when the error should surface immediately.
   *
   * A 429 is retried only when the reset is close: the concurrency limit clears in
   * milliseconds, but a spent monthly quota does not, and sleeping on it helps nobody.
   */
  #retryDelay(error: VerifNowError, attempt: number): number | null {
    const retry = this.#retry!;
    const backoff = Math.min(retry.backoffMs * 2 ** attempt, retry.maxBackoffMs);

    if (error instanceof VerifNowRateLimitError) {
      const waitMs = (error.retryAfterSeconds ?? 0) * 1000;
      if (waitMs > retry.maxBackoffMs) return null;
      return Math.max(waitMs, backoff);
    }

    if (error instanceof VerifNowServerError) return backoff;
    // A timeout is retried: the deadline is ours, and the next attempt gets a fresh one.
    if (error instanceof VerifNowConnectionError) return backoff;

    // 400, 401 and unparseable bodies will fail identically on a second attempt.
    return null;
  }

  async #requestOnce(
    url: string,
    body: string,
    options: RequestOptions,
  ): Promise<ValidationResult> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          ...this.#headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-API-KEY': this.#apiKey,
          'X-VerifNow-SDK': `node/${VERSION}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      // The caller's own cancellation is theirs to handle, not a transport failure.
      if (options.signal?.aborted) throw cause;

      const timedOut = controller.signal.aborted;
      throw new VerifNowConnectionError(
        timedOut
          ? `VerifNow request to ${url} timed out after ${timeoutMs}ms.`
          : `Could not reach the VerifNow API at ${url}. Check \`baseUrl\` and network access.`,
        { cause, timedOut },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }

    return this.#handleResponse(response);
  }

  async #handleResponse(response: Response): Promise<ValidationResult> {
    const requestId = response.headers.get('X-Request-Id') ?? undefined;
    const quota = parseQuota(response.headers);

    if (response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        throw new VerifNowResponseError(
          'VerifNow returned a success status with a body that is not valid JSON.',
          { status: response.status, requestId, cause },
        );
      }

      if (payload === null || typeof payload !== 'object') {
        throw new VerifNowResponseError(
          'VerifNow returned an unexpected response shape.',
          { status: response.status, requestId },
        );
      }

      return mapResult(payload as Record<string, unknown>, quota);
    }

    const message = await readErrorMessage(response);
    const context = { status: response.status, requestId };

    if (response.status === 401 || response.status === 403) {
      throw new VerifNowAuthError(
        `VerifNow rejected the API key (${response.status}): ${message}`,
        context,
      );
    }

    if (response.status === 429) {
      throw new VerifNowRateLimitError(`VerifNow rate limit reached: ${message}`, {
        ...context,
        quota,
        retryAfterSeconds: parseRetryAfter(response.headers, quota),
      });
    }

    if (response.status >= 500) {
      throw new VerifNowServerError(
        `VerifNow returned ${response.status}: ${message}`,
        context,
      );
    }

    throw new VerifNowRequestError(
      `VerifNow rejected the request (${response.status}): ${message}`,
      context,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseQuota(headers: Headers): QuotaInfo | undefined {
  const limit = toNumber(headers.get('X-RateLimit-Limit'));
  const remaining = toNumber(headers.get('X-RateLimit-Remaining'));
  const resetSeconds = toNumber(headers.get('X-RateLimit-Reset'));
  const overage = headers.get('X-Quota-Overage') === 'true';

  if (
    limit === undefined &&
    remaining === undefined &&
    resetSeconds === undefined &&
    !overage
  ) {
    return undefined;
  }

  return {
    limit,
    remaining,
    resetAt: resetSeconds === undefined ? undefined : new Date(resetSeconds * 1000),
    overage,
  };
}

function parseRetryAfter(headers: Headers, quota?: QuotaInfo): number | undefined {
  const retryAfter = headers.get('Retry-After');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds;

    // RFC 7231 also allows an HTTP-date.
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
    }
  }

  if (quota?.resetAt) {
    return Math.max(0, Math.ceil((quota.resetAt.getTime() - Date.now()) / 1000));
  }

  return undefined;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return response.statusText || 'no details';

    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const message = parsed.message ?? parsed.error;
      if (typeof message === 'string' && message !== '') return message;
    } catch {
      // Not JSON — a proxy or the servlet container's default error page.
    }

    return text.slice(0, 500);
  } catch {
    return response.statusText || 'no details';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mapSignals(raw: unknown): EmailSignals | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;

  return {
    syntaxValid: asBoolean(s.syntax_valid),
    mxValid: asBoolean(s.mx_valid),
    typoDetected: asBoolean(s.typo_detected),
    suggestedDomain: asString(s.suggested_domain),
    disposable: asBoolean(s.disposable),
    roleBased: asBoolean(s.role_based),
    freeProvider: asBoolean(s.free_provider),
    domainAgeDays: asNumber(s.domain_age_days),
    mxProvider: asString(s.mx_provider),
    mxQualityScore: asNumber(s.mx_quality_score),
  };
}

function mapEmailDetails(raw: unknown): EmailDetails | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;

  return {
    signals: mapSignals(d.signals),
    riskScore: asNumber(d.risk_score),
    riskLevel: asString(d.risk_level) as EmailDetails['riskLevel'],
    deliverability: asString(d.deliverability) as EmailDetails['deliverability'],
    appliedLevel: asString(d.applied_level) as EmailDetails['appliedLevel'],
  };
}

/**
 * Reads `registered`, preserving the difference between `false` and `null`.
 *
 * `asBoolean` cannot be used here: it maps `null` to `undefined`, which would erase the one
 * distinction the whole VAT design exists to carry. `false` means the registry answered and the
 * number is not there; `null` means nobody could ask. A caller that cannot tell them apart will
 * reject real businesses whenever VIES is down.
 *
 * A missing key is read as `null` for the same reason — unknown, not absent.
 */
function asRegistered(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function mapVatDetails(raw: unknown): VatDetails | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;

  return {
    formatValid: asBoolean(d.format_valid),
    registered: asRegistered(d.registered),
    countryCode: asString(d.country_code),
    source: asString(d.source) as VatDetails['source'],
    checkedAt: asDate(d.checked_at),
    traderName: asString(d.trader_name),
    traderAddress: asString(d.trader_address),
    viesAvailable: asBoolean(d.vies_available),
  };
}

/**
 * Maps the API's snake_case diagnostics onto camelCase, so a TypeScript caller is not switching
 * naming conventions mid-expression. The untouched body stays available on `raw`.
 */
function mapResult(
  payload: Record<string, unknown>,
  quota: QuotaInfo | undefined,
): ValidationResult {
  return {
    valid: payload.valid === true,
    message: asString(payload.message),
    normalizedValue: asString(payload.normalizedValue) ?? null,
    originalValue: asString(payload.originalValue),
    validationLevel: asString(payload.validationLevel) as ValidationResult['validationLevel'],
    emailDetails: mapEmailDetails(payload.emailDetails),
    vatDetails: mapVatDetails(payload.vatDetails),
    quota,
    raw: payload,
  };
}
