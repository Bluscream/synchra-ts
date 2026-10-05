/**
 * The gateway, against a fake WebSocket.
 *
 * Nothing here opens a socket. The fake records what was sent and lets a test deliver a frame, so
 * the behaviours worth checking — subscription replay across a reconnect, a bare `pong` that is not
 * JSON, a handler that throws — are all reachable deterministically.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { staticToken } from '../src/auth.js';
import { EventStream, isGatewayEvent, type WebSocketLike } from '../src/ws/stream.js';
import { keyOf, SubscriptionSet } from '../src/ws/subscriptions.js';

const CHANNEL = '0197465f-c40d-7db8-ad11-dc44b153a32d';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readonly sent: string[] = [];
  readyState = 1;

  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  /** Lets the stream finish its handshake, which it does on `onopen`. */
  open(): void {
    this.onopen?.({});
  }

  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }

  commands(): { command?: string; type?: string; nonce?: string }[] {
    return this.sent
      .filter((raw) => raw.startsWith('{'))
      .map((raw) => JSON.parse(raw) as { command?: string; type?: string; nonce?: string });
  }
}

function streamWith(token: string | null = 'secret'): {
  stream: EventStream;
  errors: unknown[];
} {
  const errors: unknown[] = [];
  const stream = new EventStream(staticToken(token), {
    webSocket: FakeSocket,
    reconnect: false,
    onError: (error) => errors.push(error),
  });

  return { stream, errors };
}

/** Connects, letting the fake socket open on the next tick so the handshake completes. */
async function connect(stream: EventStream): Promise<FakeSocket> {
  const pending = stream.connect();

  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];

  expect(socket).toBeDefined();

  socket?.open();
  await pending;

  if (socket === undefined) {
    throw new Error('No socket was created.');
  }

  return socket;
}

afterEach(() => {
  FakeSocket.instances = [];
});

describe('EventStream', () => {
  it('authorises before subscribing, so private events are allowed', async () => {
    const { stream } = streamWith('secret');

    stream.subscribe('chat_message', { channel_id: CHANNEL });

    const socket = await connect(stream);
    const commands = socket.commands();

    expect(commands[0]).toMatchObject({ command: 'authorization' });
    expect(commands[1]).toMatchObject({ command: 'subscribe', type: 'chat_message' });

    stream.close();
  });

  it('sends no authorization command for an anonymous stream', async () => {
    const { stream } = streamWith(null);

    stream.subscribe('chat_message', { channel_id: CHANNEL });

    const socket = await connect(stream);

    expect(socket.commands().map((command) => command.command)).toEqual(['subscribe']);

    stream.close();
  });

  it('sends a subscription immediately when the socket is already open', async () => {
    const { stream } = streamWith();
    const socket = await connect(stream);

    stream.subscribe('activity', { channel_id: CHANNEL });

    expect(socket.commands().at(-1)).toMatchObject({ command: 'subscribe', type: 'activity' });

    stream.close();
  });

  it('subscribes once for a repeated subscription', async () => {
    const { stream } = streamWith();
    const socket = await connect(stream);

    stream.subscribe('activity', { channel_id: CHANNEL });
    stream.subscribe('activity', { channel_id: CHANNEL });

    expect(socket.commands().filter((command) => command.command === 'subscribe')).toHaveLength(1);
    expect(stream.subscribed()).toHaveLength(1);

    stream.close();
  });

  it('sends a nonce so the gateway acknowledges the subscribe', async () => {
    const { stream } = streamWith();

    // Verified against the live gateway: with a nonce it answers an `ok` frame carrying the same
    // nonce, or an `error` one naming an unknown type. Without it a typo is silently nothing.
    stream.subscribe('chat_message', { channel_id: CHANNEL }, 'sub-1');

    const socket = await connect(stream);

    expect(socket.commands().at(-1)).toMatchObject({ command: 'subscribe', nonce: 'sub-1' });

    stream.close();
  });

  it('replays a subscription with the nonce it was given', async () => {
    const { stream } = streamWith();

    stream.subscribe('chat_message', { channel_id: CHANNEL }, 'sub-1');

    const first = await connect(stream);

    first.readyState = 3;

    const second = await connect(stream);

    // A caller watching for the ack should see it again after a reconnect.
    expect(second.commands().at(-1)).toMatchObject({ nonce: 'sub-1' });

    stream.close();
  });

  it('replays every subscription on a new socket', async () => {
    const { stream } = streamWith();

    stream.subscribe('chat_message', { channel_id: CHANNEL });
    stream.subscribe('activity', { channel_id: CHANNEL });

    const first = await connect(stream);

    first.readyState = 3;

    // This is the behaviour that makes a long-running reader possible: the caller never
    // re-subscribes after a drop.
    const second = await connect(stream);

    expect(second).not.toBe(first);
    expect(second.commands().filter((command) => command.command === 'subscribe')).toHaveLength(2);

    stream.close();
  });

  it('dispatches an event to the handler for its type', async () => {
    const { stream } = streamWith();
    const chat = vi.fn();
    const activity = vi.fn();

    stream.on('chat_message', chat);
    stream.on('activity', activity);

    const socket = await connect(stream);

    socket.deliver(JSON.stringify({ type: 'chat_message', action: 'new', data: { id: 'a' } }));

    expect(chat).toHaveBeenCalledTimes(1);
    expect(activity).not.toHaveBeenCalled();
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ action: 'new', data: { id: 'a' } });

    stream.close();
  });

  it('stops dispatching once the returned remover is called', async () => {
    const { stream } = streamWith();
    const handler = vi.fn();
    const off = stream.on('chat_message', handler);
    const socket = await connect(stream);

    off();
    socket.deliver(JSON.stringify({ type: 'chat_message', action: 'new', data: {} }));

    expect(handler).not.toHaveBeenCalled();

    stream.close();
  });

  it('ignores the bare pong keepalive rather than parsing it', async () => {
    const { stream, errors } = streamWith();
    const any = vi.fn();

    stream.onAny(any);

    const socket = await connect(stream);

    // The gateway answers `ping` with the bare word `pong`. A client that pipes every frame through
    // JSON.parse throws on its own heartbeat.
    socket.deliver('pong');
    socket.deliver('');

    expect(any).not.toHaveBeenCalled();
    expect(errors).toEqual([]);

    stream.close();
  });

  it('reports an unparsable frame instead of throwing on it', async () => {
    const { stream, errors } = streamWith();
    const socket = await connect(stream);

    socket.deliver('{not json');

    expect(errors).toHaveLength(1);

    stream.close();
  });

  it('keeps running when a handler throws', async () => {
    const { stream, errors } = streamWith();
    const second = vi.fn();

    stream.on('chat_message', () => {
      throw new Error('bad handler');
    });
    stream.on('chat_message', second);

    const socket = await connect(stream);

    socket.deliver(JSON.stringify({ type: 'chat_message', action: 'new', data: {} }));

    // One bad message must not end a stream meant to run for days.
    expect(errors).toHaveLength(1);
    expect(second).toHaveBeenCalledTimes(1);

    stream.close();
  });

  it('passes control frames to onAny but not to an event handler', async () => {
    const { stream } = streamWith();
    const any = vi.fn();
    const chat = vi.fn();

    stream.onAny(any);
    stream.on('chat_message', chat);

    const socket = await connect(stream);

    socket.deliver(
      JSON.stringify({ type: 'error', action: 'new', data: { code: 400 }, nonce: 'sub-1' }),
    );

    expect(any).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();

    stream.close();
  });

  it('unsubscribes, and drops everything at once', async () => {
    const { stream } = streamWith();
    const socket = await connect(stream);

    stream.subscribe('activity', { channel_id: CHANNEL });
    stream.unsubscribe('activity', { channel_id: CHANNEL });

    expect(stream.subscribed()).toHaveLength(0);
    expect(socket.commands().at(-1)).toMatchObject({ command: 'unsubscribe', type: 'activity' });

    stream.subscribe('activity', { channel_id: CHANNEL });
    stream.unsubscribeAll();

    expect(stream.subscribed()).toHaveLength(0);
    expect(socket.commands().at(-1)).toEqual({ command: 'unsubscribe' });

    stream.close();
  });

  it('reports open and close', async () => {
    const { stream } = streamWith();
    const onOpen = vi.fn();
    const onClose = vi.fn();

    stream.onOpen(onOpen);
    stream.onClose(onClose);

    await connect(stream);

    expect(onOpen).toHaveBeenCalledTimes(1);

    stream.close();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stream.isOpen()).toBe(false);
  });

  it('yields events as an async iterable', async () => {
    const { stream } = streamWith();
    const socket = await connect(stream);
    const iterator = stream.events();

    socket.deliver(JSON.stringify({ type: 'chat_message', action: 'new', data: { id: 'a' } }));

    const first = await iterator.next();

    expect(first.value).toMatchObject({ data: { id: 'a' } });

    await iterator.return();
    stream.close();
  });

  it('refuses to connect with no WebSocket available', () => {
    const stream = new EventStream(staticToken(null), { url: 'wss://example.invalid' });
    const original = globalThis.WebSocket;

    try {
      // @ts-expect-error — removing a global to stand in for a runtime that has none.
      delete globalThis.WebSocket;

      expect(() => stream.connect()).toThrow(/No WebSocket implementation/);
    } finally {
      globalThis.WebSocket = original;
    }
  });
});

describe('SubscriptionSet', () => {
  it('treats the same type and data as one subscription', () => {
    const set = new SubscriptionSet();

    expect(set.add('activity', { channel_id: CHANNEL })).toBe(true);
    expect(set.add('activity', { channel_id: CHANNEL })).toBe(false);
    expect(set.size).toBe(1);
  });

  it('does not let a different nonce make a second subscription', () => {
    // The gateway matches an unsubscribe on type and data alone, so two subscribes to the same
    // channel are one subscription whatever nonce they carried.
    const set = new SubscriptionSet();

    expect(set.add('activity', { channel_id: CHANNEL }, 'a')).toBe(true);
    expect(set.add('activity', { channel_id: CHANNEL }, 'b')).toBe(false);
    expect(set.size).toBe(1);
  });

  it('keys independently of the order the data was written in', () => {
    // `widget_value` subscribes with three fields, and nothing says a caller writes them in the
    // same order twice.
    expect(keyOf('widget_value', { channel_id: 'a', key: 'b', widget_id: 'c' })).toBe(
      keyOf('widget_value', { widget_id: 'c', key: 'b', channel_id: 'a' }),
    );
  });

  it('removes only the matching subscription', () => {
    const set = new SubscriptionSet();

    set.add('activity', { channel_id: 'a' });
    set.add('activity', { channel_id: 'b' });

    expect(set.remove('activity', { channel_id: 'a' })).toMatchObject({ type: 'activity' });
    expect(set.remove('activity', { channel_id: 'zzz' })).toBeUndefined();
    expect(set.size).toBe(1);
  });
});

describe('isGatewayEvent', () => {
  it('separates a record change from an acknowledgement', () => {
    expect(isGatewayEvent({ type: 'chat_message', action: 'new', data: {} } as never)).toBe(true);
    expect(isGatewayEvent({ type: 'ok', action: 'new', data: {} })).toBe(false);
    expect(isGatewayEvent({ type: 'error', action: 'new', data: {} })).toBe(false);
  });
});
