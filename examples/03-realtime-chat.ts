#!/usr/bin/env tsx
/**
 * Live chat from the realtime gateway.
 *
 *   npx tsx examples/03-realtime-chat.ts <channel-id>
 *
 * No token needed: chat is public. Set SYNCHRA_TOKEN for the events that are not.
 *
 * Two things worth copying from here. `MessageContent.contentParts` reads whichever list carries the
 * content, because a notice — a gift, a sub, a raid — leaves `message_parts` empty and puts
 * everything in `notice_message_parts`; a reader that knows only the first renders every gift as a
 * blank line. And the stream is closed on SIGINT, because it owns a socket and a keepalive timer.
 */
import { MessageContent, Synchra } from '../src/index.js';

const channel_id = process.argv[2];

if (channel_id === undefined) {
  console.error('Usage: npx tsx examples/03-realtime-chat.ts <channel-id>');
  process.exit(1);
}

const synchra = Synchra.fromEnvironment({
  // Without this, a throwing handler and an unparsable frame both vanish: the stream reports them
  // here rather than taking the socket down, because one bad message must not end a reader that is
  // meant to run for days.
  gateway: {
    onError: (error, context) => {
      console.error(`gateway ${context}:`, error);
    },
  },
});

const stream = synchra.events();

stream.on('chat_message', (event) => {
  if (event.action !== 'new') {
    // The same event type arrives for an edit and a deletion. Rendering those as new messages is a
    // common and confusing bug.
    return;
  }

  const text = MessageContent.plainText(MessageContent.contentParts(event.data));
  const label = MessageContent.isNotice(event.data) ? '*' : ' ';

  console.log(`${label} ${event.data.viewer_display_name}: ${text}`);
});

stream.onOpen(() => {
  console.log('Connected. Ctrl-C to stop.');
});

stream.subscribe('chat_message', { channel_id });

process.on('SIGINT', () => {
  stream.close();
  process.exit(0);
});

await stream.connect();
