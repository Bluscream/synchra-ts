/**
 * The README's snippets, as code.
 *
 * A documented call that does not compile is worse than no documentation — and the names here come
 * from generated summaries, so they move when the API's do. This file is type-checked by
 * `npm run typecheck` like everything else, which is most of the point; the assertions just prove
 * the calls reach the wire the way the README says they do.
 */
import { describe, expect, it } from 'vitest';

import {
  ApiClient,
  ApiError,
  AuthorizationError,
  MessageContent,
  RateLimitError,
  Synchra,
  paginate,
  profileUrl,
  type Activity,
  type ChatMessage,
  type GatewayEvent,
} from '../src/index.js';
import { staticToken } from '../src/auth.js';

const channel_id = '0197465f-c40d-7db8-ad11-dc44b153a32d';

/** A client whose every request answers with one canned body, recording the urls it was given. */
function recording(body: unknown): { synchra: Synchra; urls: string[] } {
  const urls: string[] = [];

  const synchra = new Synchra(staticToken('t'), {
    fetch: (url) => {
      urls.push(url);

      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );
    },
  });

  return { synchra, urls };
}

describe('the README', () => {
  it('reads a channel list through the paged shape it shows', async () => {
    const { synchra } = recording({ records: [{ id: channel_id, display_name: 'A' }] });
    const page = await synchra.channel.getChannels();

    expect(page.records[0]?.display_name).toBe('A');
  });

  it('calls an operation with one options object of snake_case names', async () => {
    const { synchra, urls } = recording({ records: [] });

    await synchra.channelActivity.getActivities({
      channel_id,
      type: ['tiktok_gift', 'sub'],
      per_page: 100,
      signal: AbortSignal.timeout(5000),
    });

    expect(urls[0]).toBe(
      `https://api.synchra.net/api/2/channels/${channel_id}/activities` +
        '?per_page=100&type=tiktok_gift&type=sub',
    );
  });

  it('accepts a value outside a documented set, because the service sends them', async () => {
    const { synchra } = recording({ records: [] });

    // `type` is an OpenEnum: the known members stay suggested, and anything else still compiles.
    await synchra.channelActivity.getActivities({ channel_id, type: ['a_type_added_last_week'] });

    expect(true).toBe(true);
  });

  it('paginates with the lambda shape it shows', async () => {
    const { synchra, urls } = recording({ records: [{ type_display_name: 'Gift' }], cursor: null });
    const seen: string[] = [];

    for await (const activity of paginate((cursor) =>
      synchra.channelActivity.getActivities({ channel_id, cursor, per_page: 100 }),
    )) {
      seen.push(activity.type_display_name);
    }

    expect(seen).toEqual(['Gift']);
    expect(urls).toHaveLength(1);
  });

  it('narrows an error the way the catch block shows', async () => {
    const synchra = new Synchra(staticToken('t'), {
      retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, methods: [], statuses: [] },
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ code: 403, message: 'Forbidden', type: 'forbidden', errors: [] }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          ),
        ),
    });

    try {
      await synchra.channelActivity.getActivities({ channel_id });
      expect.unreachable('a 403 must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);

      if (error instanceof RateLimitError) {
        expect(error.retryAfterMs).toBeUndefined();
      } else if (error instanceof ApiError) {
        expect(error.status).toBe(403);
        expect(error.problems).toEqual([]);
      }
    }
  });

  it('renders a notice through contentParts, which the message_parts field alone would miss', () => {
    const message = {
      type: 'notice',
      viewer_display_name: 'Someone',
      provider: 'tiktok',
      viewer_name: 'someone',
      badges: [],
      message_parts: [],
      notice_message_parts: [
        {
          type: 'gift',
          text: '1 diamond',
          gift: { name: 'Popular Vote', image_url: 'g.webp', animated: false },
        },
      ],
    } as unknown as ChatMessage;

    const segments = MessageContent.segments(MessageContent.contentParts(message), 'lg');

    expect(segments).toEqual([
      { kind: 'gift', text: 'Popular Vote', imageUrl: 'g.webp', animated: false },
    ]);
    expect(profileUrl(message)).toBe('https://www.tiktok.com/@someone');
  });

  it('infers the gateway handler’s payload from the event type', () => {
    const synchra = Synchra.anonymous();
    const stream = synchra.events();

    // No cast anywhere below: this file would not compile if the inference were wrong.
    const off = stream.on('chat_message', (event: GatewayEvent<'chat_message'>) => {
      const name: string = event.data.viewer_display_name;

      expect(typeof name).toBe('string');
    });

    stream.on('activity', (event) => {
      const activity: Activity = event.data;

      expect(activity).toBeDefined();
    });

    stream.subscribe('chat_message', { channel_id });

    expect(stream.subscribed()).toHaveLength(1);

    off();
    stream.close();
  });

  it('reaches the client directly for an endpoint the description does not cover', async () => {
    const client = new ApiClient(staticToken('t'), {
      fetch: () => Promise.resolve(new Response('{"ok":true}')),
    });

    await expect(
      client.request<{ ok: boolean }>({ method: 'GET', path: '/something-new' }),
    ).resolves.toEqual({ ok: true });
  });
});
