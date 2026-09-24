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
  CountryVatRates,
  EmailDetails,
  EmailSignals,
  IbanDetails,
  NasDetails,
  NifDetails,
  SsnDetails,
  PhoneDetails,
  QuotaInfo,
  RetryOptions,
  ValidationResult,
  ValidationRule,
  VatDetails,
  VatRates,
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

/** Options for `validateVat`: the per-call options, plus the company expected to hold the number. */
export interface VatValidationOptions extends RequestOptions {
  /** The company you expect to hold this VAT number, e.g. from a supplier form. At most 200 characters. */
  traderName?: string;
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

  /**
   * Validate a phone number against its country's numbering plan.
   *
   * The number must include its country code (`+33…` or `0033…`). Valid numbers come back in
   * E.164 as `normalizedValue`, with country and line type in `phoneDetails`.
   */
  validatePhone(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('phone', value, options);
  }

  /**
   * Validate an IBAN against the SWIFT registry entry for its country, then its check digits.
   *
   * `ibanDetails` reports the two separately: check digits catch a typo, the registry catches an
   * account number that could never exist in that country.
   */
  validateIban(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('iban', value, options);
  }

  /**
   * Validate a VAT number.
   *
   * Pass `traderName` to ask whether the number belongs to that company:
   * `vatDetails.traderNameMatch` answers `MATCH`, `MISMATCH` or `NOT_AVAILABLE`, and
   * `traderNameMatchSource` says who compared — VerifNow against the name VIES publishes, or VIES
   * itself where it withholds the name but checks one (Spain). Germany does neither.
   */
  validateVat(value: string, options: VatValidationOptions = {}): Promise<ValidationResult> {
    const { traderName, ...requestOptions } = options;
    const extra = traderName && traderName.trim() !== '' ? { traderName } : undefined;
    return this.#validate('vat', value, requestOptions, extra);
  }

  /**
   * Validate a Canadian Social Insurance Number: format and Luhn check digit.
   *
   * `nasDetails` flags a temporary resident's number (it expires with their permit) and numbers
   * from series not issued to individuals. Only collect a SIN where the law requires it.
   */
  validateNas(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('nas', value, options);
  }

  /**
   * Validate a US Social Security Number against the numbers the SSA never issues.
   *
   * An SSN has no check digit: a typo that lands on another possible number cannot be caught, and
   * only the SSA can confirm a number was issued. `ssnDetails.itin` flags an IRS ITIN.
   */
  validateSsn(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('ssn', value, options);
  }

  /**
   * Validate a Spanish NIF: a DNI, a NIE (foreign nationals), the K/L/M series, or a company NIF.
   *
   * `nifDetails` says which, whether it belongs to a person, and for a company its legal form.
   * Spanish only — a Portuguese NIF is a different scheme and is not accepted here.
   */
  validateNif(value: string, options?: RequestOptions): Promise<ValidationResult> {
    return this.validate('nif', value, options);
  }

  /**
   * Validate a value against any rule.
   *
   * The typed helpers above call this. Use it directly when the rule is chosen at runtime.
   */
  validate(
    rule: ValidationRule,
    value: string,
    options: RequestOptions = {},
  ): Promise<ValidationResult> {
    return this.#validate(rule, value, options);
  }

  async #validate(
    rule: ValidationRule,
    value: string,
    options: RequestOptions,
    extra?: Record<string, string>,
  ): Promise<ValidationResult> {
    if (typeof value !== 'string' || value.trim() === '') {
      // Caught here rather than server-side: an empty value consumes quota and can only fail.
      throw new VerifNowRequestError(
        `Cannot validate an empty value for rule "${rule}".`,
      );
    }

    const url = `${this.#baseUrl}/api/v1/validate/${rule}`;
    const body = JSON.stringify({ value, ...extra });
    return this.#withRetry(() =>
      this.#requestOnce('POST', url, body, options, (payload, quota) => mapResult(payload, quota)),
    );
  }

  /**
   * EU VAT rates of every member state, from the European Commission's TEDB.
   *
   * Public reference data: the call spends no quota. These are the rates a member state has, not
   * the rate a sale is charged — in B2B trade between member states the invoice is usually
   * zero-rated under the reverse charge whatever the buyer's country rate is.
   */
  async vatRates(options: RequestOptions = {}): Promise<VatRates> {
    const url = `${this.#baseUrl}/api/v1/vat/rates`;
    return this.#withRetry(() =>
      this.#requestOnce('GET', url, undefined, options, (payload) => mapVatRates(payload)),
    );
  }

  /**
   * One EU member state's VAT rates. Accepts `GR` for Greece as well as `EL`.
   *
   * A code outside the 27 member states throws {@link VerifNowRequestError} (HTTP 404).
   */
  async vatRate(countryCode: string, options: RequestOptions = {}): Promise<CountryVatRates> {
    if (typeof countryCode !== 'string' || countryCode.trim() === '') {
      throw new VerifNowRequestError('A member state code is required, e.g. "FR".');
    }
    const url = `${this.#baseUrl}/api/v1/vat/rates/${encodeURIComponent(countryCode.trim())}`;
    return this.#withRetry(() =>
      this.#requestOnce('GET', url, undefined, options, (payload) => mapCountryVatRates(payload)),
    );
  }

  /** Runs one request under the retry policy. */
  async #withRetry<T>(attemptOnce: () => Promise<T>): Promise<T> {
    const maxAttempts = this.#retry ? this.#retry.attempts + 1 : 1;

    let lastError: VerifNowError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await attemptOnce();
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

  async #requestOnce<T>(
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    options: RequestOptions,
    map: (payload: Record<string, unknown>, quota: QuotaInfo | undefined) => T,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          ...this.#headers,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
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

    return this.#handleResponse(response, map);
  }

  async #handleResponse<T>(
    response: Response,
    map: (payload: Record<string, unknown>, quota: QuotaInfo | undefined) => T,
  ): Promise<T> {
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

      return map(payload as Record<string, unknown>, quota);
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
    consultationNumber: asString(d.consultation_number),
    traderNameMatch: asString(d.trader_name_match) as VatDetails['traderNameMatch'],
    traderNameMatchSource: asString(d.trader_name_match_source) as VatDetails['traderNameMatchSource'],
  };
}

function mapPhoneDetails(raw: unknown): PhoneDetails | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;

  return {
    countryCode: asString(d.country_code),
    callingCode: asNumber(d.calling_code),
    lineType: asString(d.line_type) as PhoneDetails['lineType'],
    internationalFormat: asString(d.international_format),
    nationalFormat: asString(d.national_format),
  };
}

function mapIbanDetails(raw: unknown): IbanDetails | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;

  return {
    countryCode: asString(d.country_code),
    sepa: asBoolean(d.sepa),
    structureValid: asBoolean(d.structure_valid),
    checksumValid: asBoolean(d.checksum_valid),
    length: asNumber(d.length),
    expectedLength: asNumber(d.expected_length),
    formatted: asString(d.formatted),
  };
}

function mapNasDetails(raw: unknown): NasDetails | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;

  return {
    checksumValid: asBoolean(d.checksum_valid),
    temporaryResident: asBoolean(d.temporary_resident),
    individualSeries: asBoolean(d.individual_series),
    formatted: asString(d.formatted),
  };
}

function mapNifDetails(raw: unknown): NifDetails | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;

  return {
    type: asString(d.type) as NifDetails['type'],
    naturalPerson: asBoolean(d.natural_person),
    checksumValid: asBoolean(d.checksum_valid),
    entityLetter: asString(d.entity_letter),
    entityType: asString(d.entity_type),
  };
}

function mapSsnDetails(raw: unknown): SsnDetails | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;

  return { itin: asBoolean(d.itin) };
}

/**
 * Maps the API's snake_case diagnostics onto camelCase, so a TypeScript caller is not switching
 * naming conventions mid-expression. The untouched body stays available on `raw`.
 */
function mapCountryVatRates(raw: Record<string, unknown>): CountryVatRates {
  const numbers = (value: unknown): number[] =>
    Array.isArray(value) ? value.filter((v): v is number => asNumber(v) !== undefined) : [];

  return {
    countryCode: asString(raw.countryCode) ?? '',
    standardRate: asNumber(raw.standardRate) ?? Number.NaN,
    reducedRates: numbers(raw.reducedRates),
    regionalRates: Array.isArray(raw.regionalRates)
      ? raw.regionalRates
          .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
          .map((r) => ({
            rate: asNumber(r.rate) ?? Number.NaN,
            note: asString(r.note),
            euVatArea: asBoolean(r.euVatArea),
          }))
      : [],
    situationOn: asString(raw.situationOn),
    fetchedAt: asDate(raw.fetchedAt),
  };
}

function mapVatRates(raw: Record<string, unknown>): VatRates {
  const rates = Array.isArray(raw.rates)
    ? raw.rates
        .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
        .map(mapCountryVatRates)
    : [];
  return {
    source: asString(raw.source) ?? 'TEDB',
    sourceUrl: asString(raw.sourceUrl),
    rates,
  };
}

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
    phoneDetails: mapPhoneDetails(payload.phoneDetails),
    ibanDetails: mapIbanDetails(payload.ibanDetails),
    nasDetails: mapNasDetails(payload.nasDetails),
    nifDetails: mapNifDetails(payload.nifDetails),
    ssnDetails: mapSsnDetails(payload.ssnDetails),
    quota,
    raw: payload,
  };
}
