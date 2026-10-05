/**
 * Where the client gets its credential from.
 *
 * It is read per request rather than captured once, so a token that rotates — one fetched from a
 * secret store, or refreshed by something outside this package — reaches the next call without the
 * client being rebuilt.
 *
 * There is no token endpoint to refresh against. `POST /api/2/auth/token` does not exist, despite
 * the description declaring an `OAuth2` security scheme: its `flows` object is empty, so the scheme
 * names a mechanism the service does not expose. Tokens come from the Synchra dashboard.
 */

/** Supplies the bearer token for a request, or `null` to send none. */
export type TokenProvider = () => string | null | Promise<string | null>;

/** A fixed token. `null` or an empty string means an anonymous client. */
export function staticToken(token: string | null | undefined): TokenProvider {
  const value = token === undefined || token === '' ? null : token;

  return () => value;
}

/**
 * The token in `SYNCHRA_TOKEN`, read at each call.
 *
 * Reading it per call rather than once at construction means a process that rewrites its own
 * environment — or a test that sets the variable after importing the module — behaves as expected.
 */
export function environmentToken(variable = 'SYNCHRA_TOKEN'): TokenProvider {
  return () => {
    // Guarded rather than assumed: the rest of this package runs in a browser, where there is no
    // `process`, and a bare access would throw a ReferenceError at import time.
    const environment: Record<string, string | undefined> | undefined =
      typeof process === 'undefined' ? undefined : process.env;
    const value = environment?.[variable];

    return value === undefined || value === '' ? null : value;
  };
}

/** No credential at all, for the public read endpoints. */
export const anonymousToken: TokenProvider = () => null;
