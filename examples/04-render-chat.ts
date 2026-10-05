#!/usr/bin/env tsx
/**
 * Render recent chat with its emotes, gifts, mentions and badges as real images — not just names.
 *
 *   npx tsx examples/04-render-chat.ts [channel-id] > chat.html
 *
 * No token needed: chat is public, so this uses `Synchra.anonymous()`. Synchra resolves every emote
 * to a CDN url server-side, so rendering is just walking `MessageContent.segments()` and turning
 * each segment into text, an `<img>` or an `<a>`. The same helper works for a donation's message —
 * an activity has `message_parts` too.
 */
import { MessageContent, Synchra, type Badge, type Segment } from '../src/index.js';

const channel_id = process.argv[2] ?? '019d49d2-0891-70e5-b791-c94fd76ca590';
const synchra = Synchra.anonymous();
const page = await synchra.chat.getChatMessages({ channel_id, per_page: 40 });

/** Escapes for HTML text and for a double-quoted attribute. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSegment(segment: Segment): string {
  if (segment.imageUrl !== undefined) {
    const animated = segment.animated === true ? ' class="animated"' : '';

    // `text` is the alt: an emote's name, or a gift's. A reader with images off still reads it.
    return `<img src="${escape(segment.imageUrl)}" alt="${escape(segment.text)}" title="${escape(segment.text)}"${animated}>`;
  }

  if (segment.href !== undefined) {
    return `<a href="${escape(segment.href)}" rel="nofollow noopener">${escape(segment.text)}</a>`;
  }

  return `<span class="${segment.kind}">${escape(segment.text)}</span>`;
}

function renderBadge(badge: Badge): string {
  return badge.imageUrl === undefined
    ? `<span class="badge">${escape(badge.name)}</span>`
    : `<img class="badge" src="${escape(badge.imageUrl)}" alt="${escape(badge.name)}" title="${escape(badge.name)}">`;
}

const rows = page.records
  .slice()
  .reverse()
  .map((message) => {
    const badges = MessageContent.badges(message.badges).map(renderBadge).join('');
    // Whichever list carries the content: a notice puts everything in `notice_message_parts`.
    const body = MessageContent.segments(MessageContent.contentParts(message))
      .map(renderSegment)
      .join('');
    const notice = MessageContent.isNotice(message) ? ' notice' : '';

    return `<li class="message${notice}">${badges}<b>${escape(message.viewer_display_name)}</b> ${body}</li>`;
  })
  .join('\n');

console.log(`<!doctype html>
<meta charset="utf-8">
<title>Synchra chat</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; }
  ul { list-style: none; padding: 0; }
  .message { padding: 0.25rem 0; }
  .message.notice { background: #fff7e0; }
  img { height: 1.6em; vertical-align: -0.35em; }
  img.badge { height: 1.1em; vertical-align: -0.15em; margin-right: 0.2em; }
  .badge { font-size: 0.75em; background: #eee; border-radius: 3px; padding: 0 0.3em; margin-right: 0.2em; }
</style>
<h1>Last ${String(page.records.length)} messages</h1>
<ul>
${rows}
</ul>`);
