/**
 * Resolves the rich content of a chat message or activity into drawable {@link Segment}s and
 * {@link Badge}s.
 *
 * Synchra does the lookups server-side: a Twitch, YouTube or TikTok emote arrives already carrying
 * its CDN urls at three sizes, a gift carries an image url and its own name, a mention carries the
 * resolved display name, a link carries its url. None of that needs a second request. This collapses
 * the typed parts into one ordered list so a caller can render the images instead of the bare names
 * — the difference between showing `KPOPvictory` and showing the emote.
 *
 * It returns data, not markup, so the same helper serves a web page, a terminal and a desktop app.
 */
import type {
  ChatMessage,
  ChatMessageBadge,
  ChatMessagePart,
  EmotePart,
  GiftPart,
  ImageUrls,
} from '../generated/models.js';

/** Which of the three sizes Synchra resolves an emote or badge icon to. */
export type ImageSize = 'sm' | 'md' | 'lg';

export const SEGMENT_KINDS = ['text', 'emote', 'gift', 'mention', 'link'] as const;

export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/**
 * One drawable piece of a message, after the parts have been resolved.
 *
 * A renderer walks the list once and switches on `kind`: draw `text` as text, draw an image from
 * `imageUrl` with `text` as its alt, or draw a link to `href`. **`text` is always set and always
 * safe to show on its own**, so a renderer that ignores every other field still reads correctly.
 */
export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
  readonly imageUrl?: string | undefined;
  readonly animated?: boolean | undefined;
  readonly href?: string | undefined;
}

/**
 * A viewer badge — subscriber, moderator, VIP — resolved to a drawable icon.
 *
 * `imageUrl` is undefined when the provider gave Synchra no icon. `name` and `type` are always
 * present, so a badge with no icon can still be shown as a text chip rather than vanishing.
 */
export interface Badge {
  readonly name: string;
  readonly type: string;
  readonly imageUrl?: string | undefined;
}

export const MessageContent = {
  /**
   * The parts that actually carry a message's content.
   *
   * A chat message puts its content in `message_parts` — **except when it is a notice**, which puts
   * everything in `notice_message_parts` and leaves `message_parts` empty. A TikTok gift is the
   * common case: `type: "notice"`, `sub_type: "tiktok_gift"`, and the gift with its image sitting in
   * the notice parts. A renderer that reads only `message_parts` draws every one of those as a blank
   * row, which is how a whole category of events quietly disappears from a chat log — measured on a
   * live channel as 35 of 200 messages.
   *
   * The two have not been seen populated together, so this prefers the message parts and falls back
   * rather than merging.
   */
  contentParts(message: ChatMessage): readonly ChatMessagePart[] {
    return message.message_parts.length > 0 ? message.message_parts : message.notice_message_parts;
  },

  /**
   * Whether this message is an event rather than something somebody typed.
   *
   * Worth styling differently, and the reason {@link MessageContent.contentParts} has to look in two
   * places.
   */
  isNotice(message: ChatMessage): boolean {
    return message.type === 'notice';
  },

  /** The ordered, drawable segments of a message's parts. */
  segments(
    parts: readonly ChatMessagePart[] | null | undefined,
    emoteSize: ImageSize = 'md',
  ): Segment[] {
    return (parts ?? []).map((part) => toSegment(part, emoteSize));
  },

  /** A message's viewer badges, resolved to icons. */
  badges(badges: readonly ChatMessageBadge[] | null | undefined, size: ImageSize = 'sm'): Badge[] {
    return (badges ?? []).map((badge) => ({
      name: badge.name,
      type: badge.type,
      imageUrl: pick(badge.urls, size),
    }));
  },

  /**
   * The plain text of a message, with each emote rendered as the name it stands for.
   *
   * For a title attribute, a notification, or a log line — anywhere that cannot show images. A
   * message that is only an emote still reads as its name rather than as an empty string.
   */
  plainText(parts: readonly ChatMessagePart[] | null | undefined): string {
    return MessageContent.segments(parts)
      .map((segment) => segment.text)
      .join('')
      .trim();
  },
} as const;

/**
 * One part, resolved.
 *
 * Each rich type carries a matching sub-object, but the two are typed independently, so a part can
 * in principle name a type whose sub-object is absent. Every arm therefore checks both, and a part
 * whose sub-object did not arrive falls through to its own text — which is always there.
 */
function toSegment(part: ChatMessagePart, emoteSize: ImageSize): Segment {
  switch (part.type) {
    case 'emote':
      return present(part.emote) ? emoteSegment(part.emote, emoteSize) : textSegment(part);
    case 'gift':
      return present(part.gift) ? giftSegment(part.gift, part.text) : textSegment(part);
    case 'mention':
      return present(part.mention)
        ? { kind: 'mention', text: `@${part.mention.display_name}` }
        : textSegment(part);
    case 'link':
      // A link part carries its url, except where it does not — then the text *is* the url, which
      // is what a renderer would have had to fall back to anyway.
      return {
        kind: 'link',
        text: part.text,
        href: present(part.url) && part.url !== '' ? part.url : part.text,
      };
    case 'text':
    case 'date':
      return textSegment(part);
  }
}

function emoteSegment(emote: EmotePart, size: ImageSize): Segment {
  // The emote's name reads better than the raw token as the alt and the fallback.
  return {
    kind: 'emote',
    text: emote.name,
    imageUrl: pick(emote.urls, size),
    animated: emote.animated,
  };
}

function giftSegment(gift: GiftPart, partText: string): Segment {
  // The gift's name over the part's text: the text is a count ("1 diamond") while the name is what
  // the image actually shows ("Popular Vote"), and this string is the alt text and the fallback for
  // a renderer that draws no images.
  return {
    kind: 'gift',
    text: gift.name === '' ? partText : gift.name,
    imageUrl: gift.image_url ?? undefined,
    animated: gift.animated,
  };
}

function textSegment(part: ChatMessagePart): Segment {
  return { kind: 'text', text: part.text };
}

function pick(urls: ImageUrls | null | undefined, size: ImageSize): string | undefined {
  if (!present(urls)) {
    return undefined;
  }

  return size === 'sm' ? urls.sm : size === 'lg' ? urls.lg : urls.md;
}

/**
 * Whether an optional, nullable field actually carries a value.
 *
 * The API uses both: a field can be absent from the JSON *and* present as null, and the generated
 * types say so. One check for both, rather than `!== undefined && !== null` at each call site.
 */
function present<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}
