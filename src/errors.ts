import type { QuotaInfo } from './types.js';

/**
 * Base class for every error this SDK throws.
 *
 * The SDK fails loudly on purpose. A validation client that swallows a network failure and
 * reports `valid: true` turns an outage into silently accepted bad data, and the outage stays
 * invisible until someone audits the database. Catch these and decide explicitly — accepting the
 * input on failure is a reasonable choice, but it should be a choice.
 *
 * @example
 * ```ts
 * try {
 *   const result = await client.validateEmail(input);
 *   return result.valid;
 * } catch (error) {
 *   if (error instanceof VerifNowRateLimitError) throw error; // back-pressure, do not swallow
 *   logger.warn({ error }, 'VerifNow unavailable, accepting input unverified');
 *   return true;
 * }
 * ```
 */
export class VerifNowError extends Error {
  /** HTTP status, when the failure came back from the API rather than the network. */
  readonly status?: number;
  /** Correlation id from the `X-Request-Id` response header, useful in support requests. */
  readonly requestId?: string;

  constructor(
    message: string,
    options: { status?: number; requestId?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.requestId = options.requestId;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The API key is missing, malformed, revoked, or not authorised for this endpoint (401/403). */
export class VerifNowAuthError extends VerifNowError {}

/**
 * The request was rejected as malformed (400).
 *
 * Retrying is pointless — the payload itself needs to change.
 */
export class VerifNowRequestError extends VerifNowError {}

/** The monthly quota or the concurrency limit was exceeded (429). */
export class VerifNowRateLimitError extends VerifNowError {
  /** Quota counters from the response headers, when present. */
  readonly quota?: QuotaInfo;
  /** Seconds to wait before retrying, derived from `Retry-After` or `X-RateLimit-Reset`. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      status?: number;
      requestId?: string;
      cause?: unknown;
      quota?: QuotaInfo;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message, options);
    this.quota = options.quota;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** The API failed to process the request (5xx). Retried automatically before surfacing. */
export class VerifNowServerError extends VerifNowError {}

/**
 * The API could not be reached at all: DNS failure, refused connection, TLS error, or the
 * request exceeded `timeoutMs`.
 *
 * A wrong `baseUrl` surfaces here, which is why it names the URL it tried.
 */
export class VerifNowConnectionError extends VerifNowError {
  /** True when the failure was the client-side timeout rather than a transport error. */
  readonly timedOut: boolean;

  constructor(
    message: string,
    options: { cause?: unknown; timedOut?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.timedOut = options.timedOut ?? false;
  }
}

/** The API returned a success status with a body this SDK could not parse. */
export class VerifNowResponseError extends VerifNowError {}
