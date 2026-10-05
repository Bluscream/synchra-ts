/**
 * The client, against a fake `fetch`.
 *
 * No network: every test here supplies its own responses, so the suite is deterministic and runs
 * offline. The live API is exercised separately in test/live.test.ts, which skips without a token.
 */
import { describe, expect, it, vi } from 'vitest';

import { ApiClient, delayFor, parseErrorBody, shouldRetry } from '../src/client.js';
import {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  NotFoundError,
  RateLimitError,
  SerializationError,
  ServerError,
  TransportError,
  ValidationError,
} from '../src/errors.js';
import { staticToken } from '../src/auth.js';
import { DEFAULT_RETRY_POLICY } from '../src/wire.js';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: BodyInit | null | undefined;
}

/** A `fetch` that answers from a script and records what it was asked. */
function fakeFetch(responses: readonly Response[]): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];

  return {
    calls,
    fetch: (url, init) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body,
      });

      const next = queue.shift();

      if (next === undefined) {
        throw new Error(`The fake fetch ran out of responses on call ${String(calls.length)}.`);
      }

      return Promise.resolve(next);
    },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('ApiClient', () => {
  it('builds the url from the base, the path and the query', async () => {
    const { fetch, calls } = fakeFetch([json({ ok: true })]);
    const client = new ApiClient(staticToken(null), { fetch });

    await client.request({ method: 'GET', path: '/channels', query: { per_page: 50 } });

    expect(calls[0]?.url).toBe('https://api.synchra.net/api/2/channels?per_page=50');
  });

  it('leaves out query parameters the caller did not set', async () => {
    const { fetch, calls } = fakeFetch([json([])]);
    const client = new ApiClient(staticToken(null), { fetch });

    // An absent filter and an empty one are different to the API: `?type=` would filter on the
    // empty string rather than not filtering.
    await client.request({
      method: 'GET',
      path: '/channels',
      query: { type: undefined, cursor: null, per_page: 10 },
    });

    expect(calls[0]?.url).toBe('https://api.synchra.net/api/2/channels?per_page=10');
  });

  it('sends the token as a bearer header, read per request', async () => {
    const tokens = ['first', 'second'];
    const { fetch, calls } = fakeFetch([json({}), json({})]);
    const client = new ApiClient(() => tokens.shift() ?? null, { fetch });

    await client.request({ method: 'GET', path: '/user' });
    await client.request({ method: 'GET', path: '/user' });

    expect(calls[0]?.headers.authorization).toBe('Bearer first');
    expect(calls[1]?.headers.authorization).toBe('Bearer second');
  });

  it('sends no authorization header for an anonymous client', async () => {
    const { fetch, calls } = fakeFetch([json([])]);
    const client = new ApiClient(staticToken(null), { fetch });

    await client.request({ method: 'GET', path: '/currencies.json' });

    expect(calls[0]?.headers).not.toHaveProperty('authorization');
  });

  it('merges headers so a per-call one wins over the client’s', async () => {
    const { fetch, calls } = fakeFetch([json({})]);
    const client = new ApiClient(staticToken(null), {
      fetch,
      headers: { 'x-trace': 'client', 'x-keep': 'yes' },
    });

    await client.request({
      method: 'GET',
      path: '/user',
      options: { headers: { 'x-trace': 'call' } },
    });

    expect(calls[0]?.headers['x-trace']).toBe('call');
    expect(calls[0]?.headers['x-keep']).toBe('yes');
  });

  it('JSON-encodes a body and sets the content type', async () => {
    const { fetch, calls } = fakeFetch([json({ id: 'a' }, 201)]);
    const client = new ApiClient(staticToken('t'), { fetch });

    await client.request({ method: 'POST', path: '/channels', body: { display_name: 'x' } });

    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toBe('{"display_name":"x"}');
  });

  it('sends a raw body untouched', async () => {
    const { fetch, calls } = fakeFetch([json({}, 201)]);
    const client = new ApiClient(staticToken('t'), { fetch });
    const bytes = new Uint8Array([1, 2, 3]);

    await client.request({ method: 'POST', path: '/files', rawBody: bytes });

    expect(calls[0]?.body).toBe(bytes);
    expect(calls[0]?.headers['content-type']).toBe('application/octet-stream');
  });

  it('resolves a 204 and an empty body to undefined', async () => {
    const { fetch } = fakeFetch([new Response(null, { status: 204 }), new Response('')]);
    const client = new ApiClient(staticToken('t'), { fetch });

    await expect(client.send({ method: 'DELETE', path: '/channels/a' })).resolves.toBeUndefined();
    await expect(client.request({ method: 'GET', path: '/x' })).resolves.toBeUndefined();
  });

  it('rejects a base url that is not http or https', () => {
    expect(() => new ApiClient(staticToken(null), { baseUrl: 'ftp://example.com' })).toThrow(
      ConfigurationError,
    );
    expect(() => new ApiClient(staticToken(null), { baseUrl: '   ' })).toThrow(ConfigurationError);
  });

  it('strips trailing slashes from the base url', async () => {
    const { fetch, calls } = fakeFetch([json({})]);
    const client = new ApiClient(staticToken(null), {
      fetch,
      baseUrl: 'https://dash.synchra.net/api/2///',
    });

    await client.request({ method: 'GET', path: '/user' });

    expect(calls[0]?.url).toBe('https://dash.synchra.net/api/2/user');
  });

  describe('error mapping', () => {
    const cases: readonly [number, unknown][] = [
      [401, AuthenticationError],
      [403, AuthorizationError],
      [404, NotFoundError],
      [422, ValidationError],
      [429, RateLimitError],
      [503, ServerError],
    ];

    for (const [status, expected] of cases) {
      it(`turns a ${String(status)} into the matching error`, async () => {
        const { fetch } = fakeFetch([
          json({ code: status, message: 'nope', type: 'x', errors: [] }, status),
        ]);
        // One attempt, so the retryable statuses here fail immediately rather than waiting.
        const client = new ApiClient(staticToken('t'), {
          fetch,
          retry: { ...DEFAULT_RETRY_POLICY, attempts: 1 },
        });

        await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
          expected as never,
        );
      });
    }

    it('carries the status and the per-field problems of a 422', async () => {
      const { fetch } = fakeFetch([
        json(
          {
            code: 422,
            message: 'Validation error',
            type: 'validation_error',
            errors: [{ field: 'provider', message: 'not a valid provider', type: 'enum' }],
          },
          422,
        ),
      ]);
      const client = new ApiClient(staticToken('t'), { fetch });

      await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
        status: 422,
        type: 'validation_error',
        problems: [{ field: 'provider' }],
      });
    });

    it('keeps the real status when the body is not the error envelope', async () => {
      // A proxy error page. Parsing it must not replace a meaningful 502 with a parse failure.
      const { fetch } = fakeFetch([
        new Response('<html><body>Bad Gateway</body></html>', { status: 502 }),
      ]);
      const client = new ApiClient(staticToken('t'), {
        fetch,
        retry: { ...DEFAULT_RETRY_POLICY, attempts: 1 },
      });

      await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
        status: 502,
        error: undefined,
      });
    });

    it('reports an undecodable success body as a serialization failure', async () => {
      const { fetch } = fakeFetch([new Response('{not json', { status: 200 })]);
      const client = new ApiClient(staticToken('t'), { fetch });

      await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
        SerializationError,
      );
    });

    it('wraps a network failure as a transport error', async () => {
      const client = new ApiClient(staticToken('t'), {
        fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      });

      await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
        TransportError,
      );
    });
  });

  describe('retries', () => {
    it('retries a GET that answered 429 and returns the eventual success', async () => {
      const { fetch, calls } = fakeFetch([
        json({ code: 429, message: 'slow down', type: 'rate_limited', errors: [] }, 429, {
          'retry-after': '0',
        }),
        json({ ok: true }),
      ]);
      const client = new ApiClient(staticToken('t'), { fetch });

      await expect(client.request({ method: 'GET', path: '/x' })).resolves.toEqual({ ok: true });
      expect(calls).toHaveLength(2);
    });

    it('does not retry a POST, which is not idempotent', async () => {
      const { fetch, calls } = fakeFetch([
        json({ code: 429, message: 'slow down', type: 'rate_limited', errors: [] }, 429, {
          'retry-after': '0',
        }),
      ]);
      const client = new ApiClient(staticToken('t'), { fetch });

      await expect(client.request({ method: 'POST', path: '/x', body: {} })).rejects.toBeInstanceOf(
        RateLimitError,
      );
      expect(calls).toHaveLength(1);
    });

    it('gives up after the configured number of attempts', async () => {
      const failing = (): Response =>
        json({ code: 503, message: 'down', type: '', errors: [] }, 503, { 'retry-after': '0' });
      const { fetch, calls } = fakeFetch([failing(), failing(), failing()]);
      const client = new ApiClient(staticToken('t'), { fetch });

      await expect(client.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(
        ServerError,
      );
      expect(calls).toHaveLength(DEFAULT_RETRY_POLICY.attempts);
    });

    it('reports every attempt through onRequest', async () => {
      const onRequest = vi.fn();
      const { fetch } = fakeFetch([
        json({ code: 429, message: '', type: '', errors: [] }, 429, { 'retry-after': '0' }),
        json({ ok: true }),
      ]);
      const client = new ApiClient(staticToken('t'), { fetch, onRequest });

      await client.request({ method: 'GET', path: '/x' });

      expect(onRequest).toHaveBeenCalledTimes(2);
      expect(onRequest.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, status: 200 });
    });

    it('aborts the wait rather than sleeping it out', async () => {
      const controller = new AbortController();
      const { fetch } = fakeFetch([
        json({ code: 429, message: '', type: '', errors: [] }, 429, { 'retry-after': '30' }),
      ]);
      const client = new ApiClient(staticToken('t'), { fetch });

      const pending = client.request({
        method: 'GET',
        path: '/x',
        options: { signal: controller.signal },
      });

      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(TransportError);
    });
  });
});

describe('shouldRetry', () => {
  it('retries only an idempotent method on a retryable status, within the attempt budget', () => {
    expect(shouldRetry(DEFAULT_RETRY_POLICY, 'GET', 429, 1)).toBe(true);
    expect(shouldRetry(DEFAULT_RETRY_POLICY, 'POST', 429, 1)).toBe(false);
    expect(shouldRetry(DEFAULT_RETRY_POLICY, 'GET', 404, 1)).toBe(false);
    expect(shouldRetry(DEFAULT_RETRY_POLICY, 'GET', 429, DEFAULT_RETRY_POLICY.attempts)).toBe(
      false,
    );
  });
});

describe('delayFor', () => {
  it('doubles the base delay per attempt, up to the ceiling', () => {
    expect(delayFor(DEFAULT_RETRY_POLICY, 1, null)).toBe(500);
    expect(delayFor(DEFAULT_RETRY_POLICY, 2, null)).toBe(1000);
    expect(delayFor(DEFAULT_RETRY_POLICY, 20, null)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it('prefers the service’s own Retry-After, still capped', () => {
    expect(delayFor(DEFAULT_RETRY_POLICY, 1, '2')).toBe(2000);
    expect(delayFor(DEFAULT_RETRY_POLICY, 1, '3600')).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it('reads Retry-After as an HTTP date too', () => {
    const soon = new Date(Date.now() + 2000).toUTCString();

    expect(delayFor(DEFAULT_RETRY_POLICY, 1, soon)).toBeGreaterThan(0);
  });

  it('falls back to backoff for a Retry-After it cannot read', () => {
    expect(delayFor(DEFAULT_RETRY_POLICY, 1, 'soonish')).toBe(500);
  });
});

describe('parseErrorBody', () => {
  it('accepts the envelope the service actually sends', () => {
    expect(
      parseErrorBody(
        '{"code": 401, "message": "Not authenticated", "type": "unauthenticated", "errors": []}',
      ),
    ).toEqual({ code: 401, message: 'Not authenticated', type: 'unauthenticated', errors: [] });
  });

  it('defaults the empty type a routing 404 sends', () => {
    expect(parseErrorBody('{"code": 404, "message": "Not Found"}')).toEqual({
      code: 404,
      message: 'Not Found',
      type: '',
      errors: [],
    });
  });

  it('returns undefined for anything that is not the envelope', () => {
    expect(parseErrorBody('not json')).toBeUndefined();
    expect(parseErrorBody('[1, 2]')).toBeUndefined();
    expect(parseErrorBody('{"detail": "FastAPI style"}')).toBeUndefined();
  });
});
