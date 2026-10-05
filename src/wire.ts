/**
 * The vocabulary the generated layer and the client share: what a request looks like, what a caller
 * may set per call, and how path and query values reach the URL.
 */

/**
 * An ISO 8601 timestamp, exactly as the API sends it (`2026-10-05T18:42:11.123456Z`).
 *
 * Deliberately a `string` rather than a `Date`. Reviving timestamps into `Date` objects means the
 * decoded body is no longer the JSON that arrived — it cannot be re-serialised and sent back
 * unchanged, a `Date` loses the sub-second precision the API sends, and every consumer has to know
 * which fields were rewritten. `new Date(value)` is one call away where a caller actually wants one.
 */
export type IsoDateTime = string;

/**
 * A value set the API documents but does not close.
 *
 * Several fields are described as "one of these literals, or any string" — the description models
 * an activity type as a union of every platform's enum plus a bare `string`, and the service does
 * send values that are in none of the enums. Written as a plain union, TypeScript absorbs the
 * literals into `string` and an editor offers no completions at all; this keeps them suggested
 * while still accepting anything.
 *
 * The intersection with an empty record is what stops the absorption. `string & {}` is the usual
 * spelling of it; this one avoids the bare `{}` type.
 */
export type OpenEnum<Known extends string> = Known | (string & Record<never, never>);

/** A value that can go in a query string or a path segment. */
export type ParamValue = string | number | boolean | null | undefined;

/** What a caller may set on any single call. */
export interface RequestOptions {
  /**
   * Aborts the request.
   *
   * Also aborts the retries: a signal that fires between attempts stops the wait rather than
   * sleeping it out first.
   */
  signal?: AbortSignal | undefined;

  /**
   * Headers for this call, merged over the client's and the operation's own.
   *
   * Not the place for credentials — pass a {@link TokenProvider} to the client instead, so a
   * rotating token is read per request rather than captured once.
   */
  headers?: Readonly<Record<string, string | undefined>> | undefined;

  /** Overrides the client's retry policy for this call. */
  retry?: RetryPolicy | undefined;
}

/** How to behave when the service answers 429 or 5xx. */
export interface RetryPolicy {
  /** Attempts in total, including the first. `1` disables retrying. */
  readonly attempts: number;

  /** Base delay in milliseconds; each attempt doubles it. */
  readonly baseDelayMs: number;

  /** Ceiling for one wait, before `Retry-After` is considered. */
  readonly maxDelayMs: number;

  /**
   * Methods worth retrying.
   *
   * `GET`, `PUT` and `DELETE` are idempotent, so a retry cannot double an effect. `POST` and
   * `PATCH` are not, and are left out: a 429 is answered before the handler runs, but a 502 from a
   * proxy can arrive after it did, and retrying that creates a second resource.
   */
  readonly methods: readonly string[];

  /** Statuses worth retrying. */
  readonly statuses: readonly number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  methods: ['GET', 'PUT', 'DELETE', 'HEAD'],
  statuses: [429, 500, 502, 503, 504],
};

/** One request, as the generated layer describes it. */
export interface ApiRequestSpec {
  readonly method: string;
  /** Relative to the client's base URL, with path parameters already substituted. */
  readonly path: string;
  readonly query?: Readonly<Record<string, ParamValue | readonly ParamValue[]>> | undefined;
  readonly headers?: Readonly<Record<string, ParamValue>> | undefined;
  /** JSON-encoded before it is sent. */
  readonly body?: unknown;
  /**
   * Sent as-is, for the upload endpoints.
   *
   * `BodyInit` rather than a narrower union, because that is exactly what the runtime's `fetch`
   * accepts — a `Uint8Array`, an `ArrayBuffer`, a `Blob`, a string, a `FormData` or a stream — and
   * restating a subset of it here would reject bodies that work.
   */
  readonly rawBody?: BodyInit | undefined;
  readonly contentType?: string | undefined;
  /** What the caller passed, for `signal`, `headers` and `retry`. */
  readonly options?: RequestOptions | undefined;
}

/**
 * Substitutes `{name}` placeholders in a path template.
 *
 * Each value is percent-encoded, so an id containing a slash cannot escape its segment and reach a
 * different route — which is the whole reason this is a function rather than a template literal in
 * each of 241 generated methods.
 */
export function expandPath(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = values[name];

    if (value === undefined) {
      throw new TypeError(`The path parameter "${name}" is required by ${template}.`);
    }

    return encodeURIComponent(String(value));
  });
}

/**
 * Builds a query string, leaving out what the caller did not set.
 *
 * `undefined` and `null` are both omitted rather than sent as empty: the API treats an absent
 * filter and an empty one differently, and an accidental `?type=` would filter on the empty string.
 * An array repeats the key, which is what FastAPI reads back as a list.
 */
export function buildQuery(
  query: Readonly<Record<string, ParamValue | readonly ParamValue[]>> | undefined,
): string {
  if (query === undefined) {
    return '';
  }

  const search = new URLSearchParams();

  for (const key of Object.keys(query).sort((a, b) => a.localeCompare(b))) {
    const value = query[key];

    for (const item of Array.isArray(value) ? value : [value as ParamValue]) {
      if (item !== undefined && item !== null) {
        search.append(key, String(item));
      }
    }
  }

  const built = search.toString();

  return built === '' ? '' : `?${built}`;
}

/** Drops the headers a caller left unset, and lowercases the names so merging is predictable. */
export function cleanHeaders(
  ...sources: readonly (Readonly<Record<string, ParamValue>> | undefined)[]
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const source of sources) {
    if (source === undefined) {
      continue;
    }

    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined && value !== null) {
        out[name.toLowerCase()] = String(value);
      }
    }
  }

  return out;
}

/** Imported for the doc link above; the real one lives in auth.ts. */
export type { TokenProvider } from './auth.js';
