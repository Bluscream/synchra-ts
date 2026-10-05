/**
 * Read-only checks against the live API.
 *
 * Skipped unless the environment names something to read, so `npm test` on a clean checkout needs
 * no network and no credentials:
 *
 * - `SYNCHRA_PUBLIC_CHANNEL_ID` runs the anonymous ones, which need no token.
 * - `SYNCHRA_TOKEN` additionally runs the authenticated ones.
 *
 * **Every request here is a GET.** Nothing in this file creates, updates or deletes anything, and
 * nothing in this file should: a test suite must never use somebody's real channel as scratch space.
 */
import { describe, expect, it } from 'vitest';

import { ApiError, AuthenticationError } from '../src/errors.js';
import { Synchra } from '../src/synchra.js';

const CHANNEL = process.env.SYNCHRA_PUBLIC_CHANNEL_ID;
const TOKEN = process.env.SYNCHRA_TOKEN;

describe.skipIf(CHANNEL === undefined)('the live API, anonymously', () => {
  const synchra = Synchra.anonymous();
  const channel_id = CHANNEL ?? '';

  it('serves the reference lists without a credential', async () => {
    const rates = await synchra.currencies.getCurrencyRates();

    expect(typeof rates).toBe('object');
  });

  it('serves a channel’s providers without a credential', async () => {
    await expect(
      synchra.channelProvider.getChannelProviders({ channel_id }),
    ).resolves.toBeDefined();
  });

  it('serves a channel’s chat messages without a credential', async () => {
    const page = await synchra.chat.getChatMessages({ channel_id, per_page: 5 });

    expect(Array.isArray(page.records)).toBe(true);
  });

  it('answers 401 for an endpoint that needs a token', async () => {
    // The published description cannot tell you which endpoints are public, so this is the check
    // that the nine marked `security: []` in the overlay are the ones that actually are.
    await expect(synchra.user.userInfo()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('answers 404 with the error envelope the client expects', async () => {
    try {
      await synchra.api.request({ method: 'GET', path: '/definitely-not-a-route' });
      expect.unreachable('a missing route should not resolve');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
    }
  });
});

describe.skipIf(TOKEN === undefined)('the live API, with a token', () => {
  const synchra = Synchra.fromEnvironment();

  it('reads the authenticated user', async () => {
    const me = await synchra.user.userInfo();

    expect(typeof me).toBe('object');
  });

  it('reads the channels the token can see', async () => {
    const channels = await synchra.channel.getChannels();

    expect(Array.isArray(channels)).toBe(true);
  });
});
