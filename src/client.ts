/**
 * Turns a request the generated layer describes into an HTTP exchange: adds the credential, encodes
 * the body, retries what is safe to retry, and converts an error status into the matching error.
 *
 * Built on `fetch`, which every supported runtime has — Node 20+, Bun, Deno, and browsers — so this
 * package has no runtime dependencies at all. Pass your own `fetch` to route through a proxy, an
 * instrumented client, or a test double.
 *
 * The generated resources are thin wrappers over {@link ApiClient.request}; call it directly to
 * reach an endpoint the vendored description does not cover yet.
 */
import { type TokenProvider, staticToken } from './auth.js';
import { ConfigurationError, SerializationError, TransportError, errorForStatus } from './errors.js';
import type { ErrorBody } from './generated/models.js';
import {
  DEFAULT_RETRY_POLICY,
  buildQuery,
  cleanHeaders,
  type ApiRequestSpec,
  type RetryPolicy,
} from './wire.js';

export const DEFAULT_BASE_URL = 'https://api.synchra.net/api/2';

/** The `fetch` signature this package needs, so a replacement does not have to match all of it. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /**
   * Where to reach the API.
   *
   * Point it at `https://dash.synchra.net/api/2` to go through the dashboard origin — it serves the
   * same API — or at a local instance when developing against one.
   */
  readonly baseUrl?: string;

  /** Sent with every request. Not the place for credentials; pass `token`. */
  readonly headers?: Readonly<Record<string, string>>;

  readonly retry?: RetryPolicy;

  /** Replaces the global `fetch`. */
  readonly fetch?: FetchLike;

  /**
   * Called once per request with the method, url and status.
   *
   * Deliberately a callback rather than a logger interface: the package should not pick a logging
   * library for its users, and everything a logger would need is in these three values.
   */
  readonly onRequest?: (event: RequestEvent) => void;
}

export interface RequestEvent {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly attempt: number;
  readonly durationMs: number;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: TokenProvider;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly retry: RetryPolicy;
  private readonly fetchImpl: FetchLike;
  private readonly onRequest: ((event: RequestEvent) => void) | undefined;

  constructor(token: TokenProvider = staticToken(null), options: ClientOptions = {}) {
    this.baseUrl = normaliseBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.token = token;
    this.headers = options.headers ?? {};
    this.retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.onRequest = options.onRequest;

    const provided = options.fetch;

    if (provided === undefined && typeof globalThis.fetch !== 'function') {
      throw new ConfigurationError(
        'No fetch implementation is available. Use Node 20 or newer, or pass one as `fetch`.',
      );
    }

    // Bound to `globalThis` because an unbound `fetch` throws "Illegal invocation" in a browser.
    this.fetchImpl = provided ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Sends one request and returns its decoded body.
   *
   * `T` is the success type; every failure throws. A `204` and an empty body both resolve to
   * `undefined`, which the generated methods type as `void`.
   */
  async request<T>(spec: ApiRequestSpec): Promise<T> {
    const url = this.url(spec);
    const method = spec.method.toUpperCase();
    const { body, contentType } = this.encodeBody(spec);
    const headers = await this.buildHeaders(spec, contentType);
    const retry = spec.options?.retry ?? this.retry;
    const signal = spec.options?.signal;

    let attempt = 0;
    let response: Response;

    for (;;) {
      attempt += 1;

      const startedAt = Date.now();

      response = await this.send(method, url, headers, body, signal);

      this.onRequest?.({
        method,
        url,
        status: response.status,
        attempt,
        durationMs: Date.now() - startedAt,
      });

      if (!shouldRetry(retry, method, response.status, attempt)) {
        break;
      }

      await sleep(delayFor(retry, attempt, response.headers.get('retry-after')), signal);
    }

    const text = await this.readBody(response, method, url);

    if (response.status >= 400) {
      throw errorForStatus(
        response.status,
        parseErrorBody(text),
        text,
        method,
        url,
        headersOf(response),
      );
    }

    return this.decode<T>(text, response.status, method, url);
  }

  private async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: BodyInit | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      // `fetch` rejects for a network failure and for an abort alike, and neither carries a status.
      // Wrapping both keeps `catch (error) { if (error instanceof SynchraError) }` complete, and the
      // cause is preserved so an abort is still recognisable by its name.
      throw new TransportError(`${method} ${url} did not complete: ${describeCause(cause)}`, {
        cause,
      });
    }
  }

  private async readBody(response: Response, method: string, url: string): Promise<string> {
    try {
      return await response.text();
    } catch (cause) {
      throw new TransportError(`${method} ${url} answered ${String(response.status)} but the body could not be read.`, {
        cause,
      });
    }
  }

  private decode<T>(text: string, status: number, method: string, url: string): T {
    if (status === 204 || text.trim() === '') {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new SerializationError(
        `${method} ${url} answered ${String(status)} with a body that is not valid JSON.`,
        { cause },
      );
    }
  }

  private url(spec: ApiRequestSpec): string {
    const path = spec.path.startsWith('/') ? spec.path : `/${spec.path}`;

    return `${this.baseUrl}${path}${buildQuery(spec.query)}`;
  }

  private encodeBody(spec: ApiRequestSpec): {
    body: BodyInit | undefined;
    contentType: string | undefined;
  } {
    if (spec.rawBody !== undefined) {
      return {
        body: spec.rawBody,
        contentType: spec.contentType ?? 'application/octet-stream',
      };
    }

    if (spec.body === undefined) {
      return { body: undefined, contentType: undefined };
    }

    return { body: JSON.stringify(spec.body), contentType: 'application/json' };
  }

  private async buildHeaders(
    spec: ApiRequestSpec,
    contentType: string | undefined,
  ): Promise<Record<string, string>> {
    const headers = cleanHeaders(
      { accept: 'application/json' },
      contentType === undefined ? undefined : { 'content-type': contentType },
      this.headers,
      spec.headers,
      spec.options?.headers,
    );

    const token = await this.token();

    if (token !== null && token !== '') {
      headers['authorization'] = `Bearer ${token}`;
    }

    return headers;
  }
}

function normaliseBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');

  if (trimmed === '') {
    throw new ConfigurationError('The API base URL cannot be empty.');
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch (cause) {
    throw new ConfigurationError(`The API base URL is not a URL: ${value}`, { cause });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigurationError(`The API base URL must be http or https, got ${value}`);
  }

  return trimmed;
}

/** The standard error envelope, or undefined for anything that is not one — a proxy error page. */
export function parseErrorBody(text: string): ErrorBody | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON at all. The status is still the real answer, so this must not become a throw of its
    // own: that would replace a meaningful 502 with a parse failure.
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const candidate = parsed as Partial<ErrorBody>;

  if (typeof candidate.code !== 'number' || typeof candidate.message !== 'string') {
    return undefined;
  }

  return {
    code: candidate.code,
    message: candidate.message,
    type: typeof candidate.type === 'string' ? candidate.type : '',
    errors: Array.isArray(candidate.errors) ? candidate.errors : [],
  };
}

export function shouldRetry(
  policy: RetryPolicy,
  method: string,
  status: number,
  attempt: number,
): boolean {
  return (
    attempt < policy.attempts &&
    policy.methods.includes(method) &&
    policy.statuses.includes(status)
  );
}

/**
 * How long to wait before the next attempt.
 *
 * `Retry-After` wins when the service sends one — it knows when the window resets and guessing
 * shorter just spends another request on another 429. It is still capped, so a header asking for an
 * hour does not hang the call.
 */
export function delayFor(policy: RetryPolicy, attempt: number, retryAfter: string | null): number {
  const advised = retryAfter === null ? undefined : parseRetryAfterHeader(retryAfter);

  if (advised !== undefined) {
    return Math.min(advised, policy.maxDelayMs);
  }

  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}

function parseRetryAfterHeader(value: string): number | undefined {
  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** A wait an abort can cut short, with its listener removed either way. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TransportError('The request was aborted while waiting to retry.'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    if (signal?.aborted === true) {
      onAbort();

      return;
    }

    // A named handler, so `removeEventListener` can actually match it: an inline arrow would leak
    // one listener per retry for the lifetime of the signal.
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function headersOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {};

  response.headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });

  return out;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === 'AbortError' ? 'the request was aborted' : cause.message;
  }

  return String(cause);
}
