import { describe, expect, it } from 'vitest';

import { MessageContent } from '../src/presentation/message-content.js';
import { profileUrl } from '../src/presentation/profile-url.js';
import type { ChatMessage, ChatMessagePart } from '../src/generated/models.js';

function part(
  overrides: Partial<ChatMessagePart> & Pick<ChatMessagePart, 'type'>,
): ChatMessagePart {
  return { text: '', ...overrides };
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    message_parts: [],
    notice_message_parts: [],
    type: 'message',
    provider: 'twitch',
    viewer_name: 'someone',
    ...overrides,
  } as ChatMessage;
}

describe('MessageContent.contentParts', () => {
  it('reads the message parts for an ordinary message', () => {
    const parts = [part({ type: 'text', text: 'hello' })];

    expect(MessageContent.contentParts(message({ message_parts: parts }))).toEqual(parts);
  });

  it('falls back to the notice parts, which is where a gift lives', () => {
    // A notice leaves message_parts empty and puts everything in notice_message_parts. A renderer
    // reading only the first draws every gift as a blank row — 35 of 200 messages on a live channel.
    const notice = [part({ type: 'gift', text: '1 diamond' })];

    expect(
      MessageContent.contentParts(
        message({ type: 'notice', message_parts: [], notice_message_parts: notice }),
      ),
    ).toEqual(notice);
  });

  it('recognises a notice', () => {
    expect(MessageContent.isNotice(message({ type: 'notice' }))).toBe(true);
    expect(MessageContent.isNotice(message({ type: 'message' }))).toBe(false);
  });
});

describe('MessageContent.segments', () => {
  it('resolves an emote to its image at the requested size', () => {
    const segments = MessageContent.segments(
      [
        part({
          type: 'emote',
          text: 'KPOPvictory',
          emote: {
            name: 'KPOPvictory',
            animated: true,
            urls: { sm: 's.png', md: 'm.png', lg: 'l.png' },
          },
        } as Partial<ChatMessagePart> & Pick<ChatMessagePart, 'type'>),
      ],
      'lg',
    );

    expect(segments).toEqual([
      { kind: 'emote', text: 'KPOPvictory', imageUrl: 'l.png', animated: true },
    ]);
  });

  it('labels a gift with its name rather than the part’s count text', () => {
    // The text is "1 diamond"; the name is what the image actually shows, and this string is the
    // alt text and the fallback for a renderer that draws no images.
    const segments = MessageContent.segments([
      part({
        type: 'gift',
        text: '1 diamond',
        gift: { name: 'Popular Vote', image_url: 'g.webp', animated: false },
      } as Partial<ChatMessagePart> & Pick<ChatMessagePart, 'type'>),
    ]);

    expect(segments[0]).toMatchObject({ kind: 'gift', text: 'Popular Vote', imageUrl: 'g.webp' });
  });

  it('falls back to the part text when a rich sub-object did not arrive', () => {
    expect(MessageContent.segments([part({ type: 'emote', text: ':shrug:' })])).toEqual([
      { kind: 'text', text: ':shrug:' },
    ]);
  });

  it('prefixes a mention with an at sign', () => {
    expect(
      MessageContent.segments([
        part({
          type: 'mention',
          text: 'bob',
          mention: { display_name: 'Bob' },
        } as Partial<ChatMessagePart> & Pick<ChatMessagePart, 'type'>),
      ]),
    ).toEqual([{ kind: 'mention', text: '@Bob' }]);
  });

  it('uses the text as the href for a link that carries no url', () => {
    expect(MessageContent.segments([part({ type: 'link', text: 'example.com' })])).toEqual([
      { kind: 'link', text: 'example.com', href: 'example.com' },
    ]);
    expect(
      MessageContent.segments([part({ type: 'link', text: 'click', url: 'https://example.com' })]),
    ).toEqual([{ kind: 'link', text: 'click', href: 'https://example.com' }]);
  });

  it('returns nothing for no parts at all', () => {
    expect(MessageContent.segments(undefined)).toEqual([]);
    expect(MessageContent.segments(null)).toEqual([]);
  });
});

describe('MessageContent.plainText', () => {
  it('reads an emote as the name it stands for', () => {
    // A message that is only an emote must not read as an empty string.
    expect(
      MessageContent.plainText([
        part({
          type: 'emote',
          text: ':v:',
          emote: { name: 'KPOPvictory', animated: false, urls: { sm: 's', md: 'm', lg: 'l' } },
        } as Partial<ChatMessagePart> & Pick<ChatMessagePart, 'type'>),
      ]),
    ).toBe('KPOPvictory');
  });

  it('joins the parts in order', () => {
    expect(
      MessageContent.plainText([
        part({ type: 'text', text: 'hi ' }),
        part({ type: 'text', text: 'there' }),
      ]),
    ).toBe('hi there');
  });
});

describe('MessageContent.badges', () => {
  it('resolves a badge icon, and keeps a badge that has none', () => {
    expect(
      MessageContent.badges([
        { name: 'Moderator', type: 'moderator', urls: { sm: 's', md: 'm', lg: 'l' } },
        { name: 'Subscriber', type: 'subscriber' },
      ] as never),
    ).toEqual([
      { name: 'Moderator', type: 'moderator', imageUrl: 's' },
      { name: 'Subscriber', type: 'subscriber', imageUrl: undefined },
    ]);
  });
});

describe('profileUrl', () => {
  it('builds a handle url for the platforms that use one', () => {
    expect(profileUrl({ provider: 'twitch', viewer_name: 'bluscream' })).toBe(
      'https://www.twitch.tv/bluscream',
    );
    expect(profileUrl({ provider: 'tiktok', viewer_name: 'someone' })).toBe(
      'https://www.tiktok.com/@someone',
    );
    expect(profileUrl({ provider: 'kick', viewer_name: 'someone' })).toBe(
      'https://kick.com/someone',
    );
  });

  it('uses the channel id for YouTube, which is its canonical url', () => {
    expect(
      profileUrl({ provider: 'youtube', viewer_name: 'handle', provider_viewer_id: 'UC123' }),
    ).toBe('https://www.youtube.com/channel/UC123');
  });

  it('returns undefined for YouTube with no channel id', () => {
    expect(profileUrl({ provider: 'youtube', viewer_name: 'handle' })).toBeUndefined();
  });

  it('returns undefined for a provider that is not somewhere people have profiles', () => {
    // 7TV is an emote host; a TTS voice is not a person.
    expect(profileUrl({ provider: '7tv', viewer_name: 'x' })).toBeUndefined();
    expect(profileUrl({ provider: 'twitch', viewer_name: '' })).toBeUndefined();
  });

  it('escapes the handle', () => {
    expect(profileUrl({ provider: 'twitch', viewer_name: 'a/b' })).toBe(
      'https://www.twitch.tv/a%2Fb',
    );
  });
});
