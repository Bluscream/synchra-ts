/**
 * One error class per failure the service actually produces.
 *
 * **None of these statuses are in the published API description.** Across its 240 operations the
 * only documented failure is `422` (plus a single `413`), so a client generated faithfully from
 * `https://api.synchra.net/openapi.json` would have no error model at all. The list here was built
 * from live responses and is supplied to the generated layer by the annotation overlay in
 * https://github.com/Bluscream/synchra-api — which is also why the generated methods' return types
 * can be the success type alone: every failure arrives here as a throw.
 *
 * Catching `SynchraError` catches everything this package throws. Catching `ApiError` catches
 * everything the *service* answered, and `error.status` is then the status it answered with.
 */
import type { ErrorBody, SubError } from './generated/models.js';

/** Base for everything this package throws. */
export class SynchraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The client was built wrong — a bad base URL, a missing token where one is required. */
export class ConfigurationError extends SynchraError {}

/** No response arrived: the network failed, the request was aborted, or the service is unreachable. */
export class TransportError extends SynchraError {}

/** A response arrived but its body was not the JSON the status implied. */
export class SerializationError extends SynchraError {}

/** Everything an {@link ApiError} carries besides its message. */
export interface ApiErrorDetails {
  readonly status: number;

  /** The parsed error envelope, when the body was one. A proxy error page is not. */
  readonly error?: ErrorBody | undefined;

  /** The body as it arrived, for the cases the envelope does not cover. */
  readonly body: string;

  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** A 4xx or 5xx response. */
export class ApiError extends SynchraError {
  readonly status: number;
  readonly error: ErrorBody | undefined;
  readonly body: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(message: string, details: ApiErrorDetails) {
    super(message);

    this.status = details.status;
    this.error = details.error;
    this.body = details.body;
    this.method = details.method;
    this.url = details.url;
    this.headers = details.headers ?? {};
  }

  /** The per-field problems a 422 carries, or an empty list for any other status. */
  get problems(): readonly SubError[] {
    return this.error?.errors ?? [];
  }

  /**
   * The service's own machine-readable classification — `unauthenticated`, `validation_error`.
   *
   * Empty on a routing 404, so branch on {@link ApiError.status} first.
   */
  get type(): string | undefined {
    return this.error?.type;
  }
}

/** 400 — the request was malformed. */
export class BadRequestError extends ApiError {}

/**
 * 401 — no credential, or one the service does not accept.
 *
 * An anonymous client answers this for anything outside the public read endpoints. A token that was
 * accepted yesterday answers it too once it is revoked, so this is worth distinguishing from
 * {@link AuthorizationError} when deciding whether to re-issue.
 */
export class AuthenticationError extends ApiError {}

/**
 * 403 — authenticated, but not allowed.
 *
 * Usually **not** a missing scope. A token issued with full access still answers 403 on a channel
 * it was not granted on, which is the single most expensive thing to learn about this API: check
 * which channel the token covers before widening its scopes.
 */
export class AuthorizationError extends ApiError {}

/** 404 — no such route, or no such record. */
export class NotFoundError extends ApiError {}

/** 409 — the request conflicts with the current state. */
export class ConflictError extends ApiError {}

/** 413 — the body is larger than the endpoint accepts. */
export class PayloadTooLargeError extends ApiError {}

/** 422 — the body or the query failed validation. {@link ApiError.problems} says where. */
export class ValidationError extends ApiError {}

/** 429 — rate limited. {@link RateLimitError.retryAfterMs} is the service's own advice. */
export class RateLimitError extends ApiError {
  /** The `Retry-After` header in milliseconds, when the response carried one. */
  get retryAfterMs(): number | undefined {
    return parseRetryAfter(this.headers['retry-after']);
  }
}

/** 5xx — the service failed. */
export class ServerError extends ApiError {}

const BY_STATUS: Readonly<Record<number, typeof ApiError>> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: AuthorizationError,
  404: NotFoundError,
  409: ConflictError,
  413: PayloadTooLargeError,
  422: ValidationError,
  429: RateLimitError,
};

/** The right error class for a status, with the message built from the body where there is one. */
export function errorForStatus(details: ApiErrorDetails): ApiError {
  const Constructor = BY_STATUS[details.status] ?? (details.status >= 500 ? ServerError : ApiError);

  return new Constructor(describe(details), details);
}

function describe(details: ApiErrorDetails): string {
  const detail = details.error?.message ?? firstLine(details.body);
  const where = `${details.method} ${details.url}`;

  return detail === undefined || detail === ''
    ? `${where} answered ${String(details.status)}.`
    : `${where} answered ${String(details.status)}: ${detail}`;
}

function firstLine(body: string): string | undefined {
  const line = body.trim().split('\n')[0]?.trim();

  // A proxy error page is HTML, and its first line is a doctype — noise rather than a message.
  if (line === undefined || line === '' || line.startsWith('<')) {
    return undefined;
  }

  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/** `Retry-After` in milliseconds. The header is either seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
