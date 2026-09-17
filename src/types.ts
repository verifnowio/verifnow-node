/**
 * Validation rules exposed by the VerifNow API.
 *
 * Each maps to `POST /api/v1/validate/{rule}`.
 */
export type ValidationRule =
  | 'email'
  | 'phone'
  | 'iban'
  | 'vat'
  | 'nas'
  | 'ssn'
  | 'nif';

export const VALIDATION_RULES: readonly ValidationRule[] = [
  'email',
  'phone',
  'iban',
  'vat',
  'nas',
  'ssn',
  'nif',
] as const;

/**
 * Depth of checks applied to a request, decided by the plan attached to the API key.
 *
 * `STANDARD` runs on the FREE and STARTER plans, `ADVANCED` on GROWTH, `PREMIUM` on PRO.
 * Branch on this rather than on the plan name: it is the only value that tells you which
 * signals are actually present in the response.
 */
export type ValidationLevel = 'BASIC' | 'STANDARD' | 'ADVANCED' | 'PREMIUM';

/** Categorical risk assessment. Returned from `ADVANCED` depth upward. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type Deliverability =
  | 'DELIVERABLE'
  | 'RISKY'
  | 'UNDELIVERABLE'
  | 'UNKNOWN';

/**
 * Per-signal breakdown behind an email verdict.
 *
 * Fields are `undefined` when the applied level does not compute them — the last four require
 * `ADVANCED` depth or higher. Check `ValidationResult.appliedLevel` before relying on one.
 */
export interface EmailSignals {
  /** The address matches the syntax pattern for the applied level. */
  syntaxValid?: boolean;
  /** The domain resolves and publishes MX (or fallback A) records. */
  mxValid?: boolean;
  /** A likely typo was found in the domain, e.g. `gmail.con`. */
  typoDetected?: boolean;
  /** The correction proposed when `typoDetected` is true. */
  suggestedDomain?: string;
  /** The domain belongs to a throwaway mailbox provider. */
  disposable?: boolean;
  /** The local part is a shared mailbox: `info@`, `admin@`, `noreply@`. */
  roleBased?: boolean;
  /** The domain is a consumer mailbox provider. Requires ADVANCED. */
  freeProvider?: boolean;
  /** Estimated age of the domain in days. Requires ADVANCED. */
  domainAgeDays?: number;
  /** Identified mail provider, e.g. `google`. Requires ADVANCED. */
  mxProvider?: string;
  /** Mail server quality between 0 and 1. Requires ADVANCED. */
  mxQualityScore?: number;
}

/** Email-specific diagnostics. Absent when the applied level is `BASIC`. */
export interface EmailDetails {
  signals?: EmailSignals;
  /** Aggregated risk on a 0–100 scale, where 0 is the lowest risk. */
  riskScore?: number;
  /** Categorical risk. Requires ADVANCED depth or higher. */
  riskLevel?: RiskLevel;
  deliverability?: Deliverability;
  /** The depth actually applied, echoed back by the API. */
  appliedLevel?: ValidationLevel;
}

/**
 * Where a VAT registration verdict came from.
 *
 * VIES publishes no SLA and drops member states several times a month, so a VAT answer is not
 * always a live one. Branch on this rather than on `ValidationResult.valid` whenever the
 * difference matters for your own compliance.
 */
export type VatSource =
  /** Confirmed against VIES during this request. */
  | 'LIVE'
  /** Served from a VIES answer less than 24 hours old. */
  | 'CACHE'
  /** VIES was unreachable, so an older cached answer was used. */
  | 'STALE'
  /** VIES was unreachable and nothing was cached. Registration is unknown. */
  | 'UNVERIFIED'
  /** The country is outside VIES, so no registry lookup is possible. */
  | 'NOT_APPLICABLE';

/** VAT-specific diagnostics. Present on `vat` validations. */
export interface VatDetails {
  /** The number matches its member state's structure. Decided locally, never depends on VIES. */
  formatValid?: boolean;
  /**
   * Present in the member state's registry.
   *
   * **`null` means unknown, never "not registered."** It is returned when VIES could not be
   * consulted. Treating `null` as `false` rejects legitimate customers during someone else's
   * outage — the single most expensive mistake available in VAT validation.
   */
  registered: boolean | null;
  /** Member state the number belongs to, e.g. `IE`. Greece is `EL`, Northern Ireland `XI`. */
  countryCode?: string;
  source?: VatSource;
  /** When the registration was last confirmed against VIES. */
  checkedAt?: Date;
  /** Registered trading name, when the member state discloses it. Germany does not. */
  traderName?: string;
  /** Registered address, when the member state discloses it. */
  traderAddress?: string;
  /** Whether VIES could answer for this country during the request. */
  viesAvailable?: boolean;
  /**
   * The consultation number VIES issued for this lookup — the receipt a tax authority accepts as
   * evidence that you checked. Present only when your account has its own VAT number configured,
   * because VIES issues one only to an identified requester.
   */
  consultationNumber?: string;
}

/**
 * Kind of line, according to the country's numbering plan.
 *
 * A `PREMIUM_RATE` or `VOIP` number is still `valid` — it exists. This is how you decide to
 * exclude one, rather than the API deciding for you.
 */
export type PhoneLineType =
  | 'MOBILE'
  | 'FIXED_LINE'
  /** The plan does not distinguish the two — the case for the US and Canada. */
  | 'FIXED_LINE_OR_MOBILE'
  | 'TOLL_FREE'
  | 'PREMIUM_RATE'
  | 'SHARED_COST'
  | 'VOIP'
  | 'PERSONAL_NUMBER'
  | 'PAGER'
  | 'UAN'
  | 'VOICEMAIL'
  | 'UNKNOWN';

/**
 * Phone-specific diagnostics. Present whenever the input parsed as an international number —
 * including when it is invalid for its country, so you can tell the user which country it was
 * read as.
 */
export interface PhoneDetails {
  /** ISO 3166-1 alpha-2 country, e.g. `FR`. Absent when the calling code is shared by several. */
  countryCode?: string;
  /** International calling code without the plus sign, e.g. `33`. */
  callingCode?: number;
  /** Absent when the number is invalid. */
  lineType?: PhoneLineType;
  /** e.g. `+33 6 12 34 56 78`. Absent when the number is invalid. */
  internationalFormat?: string;
  /** e.g. `06 12 34 56 78`. Absent when the number is invalid. */
  nationalFormat?: string;
}

/**
 * IBAN-specific diagnostics. Present on `iban` validations.
 *
 * Structure and checksum are reported separately because they fail for different reasons:
 * `structureValid` answers "could this be an account number in that country" (the SWIFT
 * registry's length and layout), `checksumValid` answers "was it typed correctly" (mod-97).
 * There is no bank name or BIC — that needs a registry the API does not hold.
 */
export interface IbanDetails {
  /** The IBAN's country, from its first two characters. */
  countryCode?: string;
  /** Length and character layout match the registry entry for that country. */
  structureValid?: boolean;
  /** The mod-97 check digits are correct. */
  checksumValid?: boolean;
  /** Length of the value as submitted, spaces removed. */
  length?: number;
  /** Length the registry requires for that country; absent for an unknown country. */
  expectedLength?: number;
  /** Print format, in groups of four. Present only for a valid IBAN. */
  formatted?: string;
}

/** Outcome of a single validation call. */
export interface ValidationResult {
  /** Whether the value passed every check the applied level ran. */
  valid: boolean;
  /** Human-readable explanation of the verdict. */
  message?: string;
  /** Canonical form of the input — `null` when the value is invalid. */
  normalizedValue: string | null;
  /** The value exactly as submitted. */
  originalValue?: string;
  /** Depth applied to this request. */
  validationLevel?: ValidationLevel;
  /** Present for email validations from `STANDARD` depth upward. */
  emailDetails?: EmailDetails;
  /** Present for VAT validations. */
  vatDetails?: VatDetails;
  /** Present for phone validations. The E.164 form is `normalizedValue`. */
  phoneDetails?: PhoneDetails;
  /** Present for IBAN validations. */
  ibanDetails?: IbanDetails;
  /** Quota state reported by the response headers. */
  quota?: QuotaInfo;
  /** The unmodified JSON body, for fields this SDK version does not model yet. */
  raw: Record<string, unknown>;
}

/** Quota counters read from the `X-RateLimit-*` response headers. */
export interface QuotaInfo {
  /** Validations included in the current billing period. */
  limit?: number;
  /** Validations left before overage or blocking. */
  remaining?: number;
  /** When the current period resets. */
  resetAt?: Date;
  /** True once you are past the included quota and into per-unit billing. */
  overage?: boolean;
}

export interface RetryOptions {
  /**
   * Retry attempts after the first failure. Defaults to 2, so up to 3 requests in total.
   * Only connection failures, 429 and 5xx are retried — never a 400 or 401, which will not
   * succeed on a second try.
   */
  attempts?: number;
  /** Delay before the first retry, in ms. Doubles each attempt. Defaults to 200. */
  backoffMs?: number;
  /** Upper bound on a single backoff delay, in ms. Defaults to 2000. */
  maxBackoffMs?: number;
}

export interface VerifNowOptions {
  /** API key created in the VerifNow dashboard. Sent as the `X-API-KEY` header. */
  apiKey: string;
  /** Override the API origin. Defaults to `https://api.verifnow.io`. */
  baseUrl?: string;
  /** Abort a single request after this many ms. Defaults to 5000. */
  timeoutMs?: number;
  /** Retry policy, or `false` to disable retries entirely. */
  retry?: RetryOptions | false;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Replacement for the global `fetch`, for tests or a custom agent.
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch;
}
