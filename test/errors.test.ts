import { describe, expect, it } from 'vitest';

import {
  ApiError,
  AuthorizationError,
  RateLimitError,
  SynchraError,
  ValidationError,
  errorForStatus,
  parseRetryAfter,
} from '../src/errors.js';

function details(overrides: Partial<Parameters<typeof errorForStatus>[0]> = {}) {
  return {
    status: 500,
    body: '',
    method: 'GET',
    url: 'https://api.synchra.net/api/2/x',
    ...overrides,
  };
}

describe('errorForStatus', () => {
  it('maps an unlisted 4xx to the base ApiError rather than guessing', () => {
    const error = errorForStatus(details({ status: 418 }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.constructor.name).toBe('ApiError');
    expect(error.status).toBe(418);
  });

  it('maps every 5xx to a server error', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(errorForStatus(details({ status })).constructor.name).toBe('ServerError');
    }
  });

  it('is catchable as SynchraError, which covers everything this package throws', () => {
    expect(errorForStatus(details({ status: 403 }))).toBeInstanceOf(SynchraError);
    expect(errorForStatus(details({ status: 403 }))).toBeInstanceOf(AuthorizationError);
  });

  it('names the class on the error, so a log line says which it was', () => {
    expect(errorForStatus(details({ status: 422 })).name).toBe('ValidationError');
  });

  it('builds the message from the envelope where there is one', () => {
    const error = errorForStatus(
      details({
        status: 401,
        error: { code: 401, message: 'Not authenticated', type: 'unauthenticated', errors: [] },
      }),
    );

    expect(error.message).toBe(
      'GET https://api.synchra.net/api/2/x answered 401: Not authenticated',
    );
  });

  it('falls back to the first line of a body that is not the envelope', () => {
    expect(errorForStatus(details({ status: 502, body: 'Bad Gateway\nmore' })).message).toContain(
      'Bad Gateway',
    );
  });

  it('does not quote an HTML error page, whose first line is a doctype', () => {
    const error = errorForStatus(details({ status: 502, body: '<!DOCTYPE html>\n<html>' }));

    expect(error.message).toBe('GET https://api.synchra.net/api/2/x answered 502.');
  });

  it('truncates a very long single-line body', () => {
    const error = errorForStatus(details({ status: 500, body: 'x'.repeat(500) }));

    expect(error.message.length).toBeLessThan(300);
    expect(error.message).toContain('…');
  });

  it('exposes the per-field problems of a validation failure', () => {
    const error = errorForStatus(
      details({
        status: 422,
        error: {
          code: 422,
          message: 'Validation error',
          type: 'validation_error',
          errors: [{ field: 'provider', message: 'bad', type: 'enum' }],
        },
      }),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.problems).toEqual([{ field: 'provider', message: 'bad', type: 'enum' }]);
    expect(error.type).toBe('validation_error');
  });

  it('reports no problems where the body was not the envelope', () => {
    expect(errorForStatus(details({ status: 500 })).problems).toEqual([]);
    expect(errorForStatus(details({ status: 500 })).type).toBeUndefined();
  });

  it('reads Retry-After off a rate-limit response', () => {
    const error = errorForStatus(details({ status: 429, headers: { 'retry-after': '30' } }));

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(30_000);
  });

  it('reports no advice where the response carried none', () => {
    const error = errorForStatus(details({ status: 429 }));

    expect((error as RateLimitError).retryAfterMs).toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP date, which is the header’s other form', () => {
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(0);
  });

  it('never advises waiting a negative time for a date in the past', () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it('returns undefined for nothing, or for something unreadable', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('  ')).toBeUndefined();
    expect(parseRetryAfter('tomorrow')).toBeUndefined();
  });
});
