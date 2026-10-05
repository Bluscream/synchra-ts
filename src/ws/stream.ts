/**
 * The realtime gateway: chat, activity, stream and widget events over one WebSocket.
 *
 * ```ts
 * const stream = synchra.events();
 *
 * stream.on('chat_message', (event) => {
 *   console.log(event.data.viewer_display_name, event.action);
 * });
 *
 * stream.subscribe('chat_message', { channel_id });
 * await stream.connect();
 * ```
 *
 * Subscriptions are remembered and replayed, so a dropped connection restores itself without the
 * caller noticing. Everything started here is stopped in {@link EventStream.close}: the socket, the
 * keepalive interval and the reconnect timer.
 */
import type { TokenProvider } from '../auth.js';
import { ConfigurationError } from '../errors.js';
import {
  EVENT_TYPES,
  type EventType,
  type GatewayEvent,
  type SubscribeData,
} from '../generated/events.js';
import type { ErrorBody } from '../generated/models.js';
import {
  SubscriptionSet,
  subscribeCommand,
  unsubscribeCommand,
  type Subscription,
} from './subscriptions.js';

export const DEFAULT_GATEWAY_URL = 'wss://api.synchra.net/api/2/ws';

/** The subset of the `WebSocket` constructor this needs, so `ws` can be passed in on Node 20. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface GatewayOptions {
  readonly url?: string;

  /** Reconnect when the socket drops. On by default; the whole point of the subscription replay. */
  readonly reconnect?: boolean;

  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly reconnectFactor?: number;

  /**
   * How often to send the keepalive.
   *
   * The gateway answers the bare text `ping` with the bare text `pong` — not JSON, which is worth
   * knowing before piping every frame through a parser.
   */
  readonly pingIntervalMs?: number;

  /**
   * Replaces the global `WebSocket`.
   *
   * Node has had a global one since 22; on 20 it is behind `--experimental-websocket`, so pass
   * `WebSocket` from the `ws` package there.
   */
  readonly webSocket?: WebSocketConstructor;

  /**
   * Called for anything that would otherwise be swallowed: a handler that threw, a frame that did
   * not parse, a socket error.
   *
   * Without this they would vanish. A throwing handler must not take the socket down with it — one
   * bad message would end a stream that is meant to run for days — so it is reported here and the
   * loop continues.
   */
  readonly onError?: (error: unknown, context: string) => void;
}

type Handler<T extends EventType> = (event: GatewayEvent<T>) => void;

/** An `ok` or `error` frame, which carry no record and so are not {@link EventType}s. */
export interface ControlFrame {
  readonly type: 'ok' | 'error';
  /** `new` in practice, but a control frame is not a record change so this is not an EventAction. */
  readonly action: string;
  readonly data: ErrorBody | Readonly<Record<string, unknown>>;
  readonly nonce?: string | null | undefined;
}

const OPEN = 1;

export class EventStream {
  private readonly subscriptions = new SubscriptionSet();
  private readonly handlers = new Map<string, Set<(event: never) => void>>();
  private readonly anyHandlers = new Set<(event: GatewayEvent | ControlFrame) => void>();
  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<() => void>();

  private socket: WebSocketLike | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private delayMs: number;
  private closed = false;
  private authorised = false;

  constructor(
    private readonly token: TokenProvider,
    private readonly options: GatewayOptions = {},
  ) {
    this.delayMs = options.reconnectDelayMs ?? 1000;
  }

  /**
   * Registers a handler for one event type, and returns the function that removes it.
   *
   * Returning the remover rather than offering an `off(type, handler)` is deliberate: an `off` that
   * takes the handler back only works if the caller kept the exact reference, which is the same
   * mistake as passing an inline arrow to `removeEventListener`.
   */
  on<T extends EventType>(type: T, handler: Handler<T>): () => void {
    const existing = this.handlers.get(type) ?? new Set();

    existing.add(handler);
    this.handlers.set(type, existing);

    return () => {
      existing.delete(handler);
    };
  }

  /** Every frame, including the `ok` and `error` control frames an event handler never sees. */
  onAny(handler: (event: GatewayEvent | ControlFrame) => void): () => void {
    this.anyHandlers.add(handler);

    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler);

    return () => {
      this.openHandlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);

    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  /**
   * Subscribes to an event type.
   *
   * Safe to call before connecting: the subscription is sent as soon as the socket is up, and
   * re-sent after every reconnect.
   */
  subscribe<T extends EventType>(type: T, data: SubscribeData[T]): this {
    if (this.subscriptions.add(type, data) && this.isOpen()) {
      this.send(subscribeCommand({ type, data }));
    }

    return this;
  }

  unsubscribe<T extends EventType>(type: T, data: SubscribeData[T]): this {
    const removed = this.subscriptions.remove(type, data);

    if (removed !== undefined && this.isOpen()) {
      this.send(unsubscribeCommand(removed));
    }

    return this;
  }

  /** Drops every subscription on this socket. */
  unsubscribeAll(): this {
    this.subscriptions.clear();

    if (this.isOpen()) {
      this.send({ command: 'unsubscribe' });
    }

    return this;
  }

  subscribed(): readonly Subscription[] {
    return this.subscriptions.all();
  }

  isOpen(): boolean {
    return this.socket?.readyState === OPEN;
  }

  /** Opens the socket and resolves once it is authorised and every subscription is sent. */
  connect(): Promise<void> {
    this.closed = false;

    if (this.isOpen()) {
      return Promise.resolve();
    }

    const Constructor = this.options.webSocket ?? webSocketFromGlobal();

    if (Constructor === undefined) {
      throw new ConfigurationError(
        'No WebSocket implementation is available. Use Node 22 or newer, or pass one as `webSocket` ' +
          "— for example `{ webSocket: (await import('ws')).WebSocket }`.",
      );
    }

    return new Promise<void>((resolve, reject) => {
      const socket = new Constructor(this.options.url ?? DEFAULT_GATEWAY_URL);

      this.socket = socket;

      socket.onopen = () => {
        this.delayMs = this.options.reconnectDelayMs ?? 1000;
        this.authorised = false;

        void this.handshake()
          .then(() => {
            this.startKeepAlive();
            this.emitLifecycle(this.openHandlers, 'onOpen');
            resolve();
          })
          .catch(reject);
      };

      socket.onmessage = (event) => {
        this.receive(event.data);
      };

      socket.onerror = (event) => {
        this.report(event, 'socket');
      };

      socket.onclose = () => {
        this.stopKeepAlive();
        this.socket = undefined;
        this.emitLifecycle(this.closeHandlers, 'onClose');

        if (!this.closed && (this.options.reconnect ?? true)) {
          this.scheduleReconnect();
        }
      };
    });
  }

  /** Closes the socket and stops everything this started. No reconnect follows. */
  close(): void {
    this.closed = true;
    this.stopKeepAlive();

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.socket?.close(1000, 'client closed');
    this.socket = undefined;
  }

  /**
   * Every event, as an async iterable.
   *
   * ```ts
   * for await (const event of stream) { … }
   * ```
   *
   * Queues what arrives while the consumer is busy, and drops the oldest past `maxQueued` rather
   * than growing without bound — a chat channel can outpace a slow consumer indefinitely, and an
   * unbounded queue turns that into an out-of-memory crash hours later.
   */
  events(maxQueued = 1024): AsyncGenerator<GatewayEvent, void, undefined> {
    const queue: GatewayEvent[] = [];
    let wake: (() => void) | undefined;

    const off = this.onAny((event) => {
      if (!isGatewayEvent(event)) {
        return;
      }

      if (queue.length >= maxQueued) {
        queue.shift();
        this.report(
          new Error(`The event queue reached ${String(maxQueued)}; the oldest event was dropped.`),
          'events',
        );
      }

      queue.push(event);
      wake?.();
    });

    const stream = async function* (
      this: EventStream,
    ): AsyncGenerator<GatewayEvent, void, undefined> {
      try {
        for (;;) {
          yield* drain(queue);

          if (this.closed) {
            return;
          }

          await new Promise<void>((resolve) => {
            wake = resolve;
          });

          wake = undefined;
        }
      } finally {
        off();
      }
    };

    return stream.call(this);
  }

  private async handshake(): Promise<void> {
    const token = await this.token();

    if (!this.authorised && token !== null && token !== '') {
      this.send({ command: 'authorization', data: { token } });
      this.authorised = true;
    }

    for (const subscription of this.subscriptions.all()) {
      this.send(subscribeCommand(subscription));
    }
  }

  private receive(raw: unknown): void {
    const text = typeof raw === 'string' ? raw.trim() : '';

    // The keepalive answer is the bare word `pong`, not JSON. A client that parses every frame
    // throws on its own heartbeat.
    if (text === '' || text === 'pong') {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      this.report(cause, 'frame');

      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return;
    }

    const frame = parsed as GatewayEvent | ControlFrame;

    for (const handler of this.anyHandlers) {
      this.guard(() => {
        handler(frame);
      }, 'onAny');
    }

    if (!isGatewayEvent(frame)) {
      return;
    }

    for (const handler of this.handlers.get(frame.type) ?? []) {
      this.guard(() => {
        (handler as (event: GatewayEvent) => void)(frame);
      }, `on(${frame.type})`);
    }
  }

  private send(command: object): void {
    this.socket?.send(JSON.stringify(command));
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();

    const interval = this.options.pingIntervalMs ?? 30_000;

    this.pingTimer = setInterval(() => {
      if (this.isOpen()) {
        this.socket?.send('ping');
      }
    }, interval);

    // Node keeps the process alive for a pending timer, which would stop a script that only meant
    // to read for a while from ever exiting. The socket itself already holds the loop open.
    unref(this.pingTimer);
  }

  private stopKeepAlive(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    const factor = this.options.reconnectFactor ?? 2;
    const ceiling = this.options.maxReconnectDelayMs ?? 30_000;
    const wait = this.delayMs;

    this.delayMs = Math.min(this.delayMs * factor, ceiling);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;

      if (!this.closed) {
        this.connect().catch((error: unknown) => {
          this.report(error, 'reconnect');
          this.scheduleReconnect();
        });
      }
    }, wait);

    unref(this.reconnectTimer);
  }

  private emitLifecycle(handlers: ReadonlySet<() => void>, context: string): void {
    for (const handler of handlers) {
      this.guard(handler, context);
    }
  }

  private guard(run: () => void, context: string): void {
    try {
      run();
    } catch (error) {
      this.report(error, context);
    }
  }

  private report(error: unknown, context: string): void {
    this.options.onError?.(error, context);
  }
}

/** Yields and removes everything currently queued. */
function* drain<T>(queue: T[]): Generator<T, void, undefined> {
  for (;;) {
    const next = queue.shift();

    if (next === undefined) {
      return;
    }

    yield next;
  }
}

/**
 * The runtime's own `WebSocket`, or undefined where there is not one.
 *
 * Node has had a global since 22; on 20 it is behind `--experimental-websocket`. The type says it
 * is always there, which is why this reads it through a widened binding rather than testing the
 * global directly.
 */
function webSocketFromGlobal(): WebSocketConstructor | undefined {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;

  return typeof candidate === 'function' ? (candidate as WebSocketConstructor) : undefined;
}

/**
 * Stops a timer from holding the process open.
 *
 * Node keeps running while a timer is pending, which would stop a script that only meant to read
 * for a while from ever exiting; the socket itself already holds the loop open. Browsers return a
 * number from `setInterval` and have no `unref`, hence the check rather than an optional call.
 */
function unref(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
}

/** Whether a frame carries a record, as opposed to being an `ok` or `error` acknowledgement. */
export function isGatewayEvent(frame: GatewayEvent | ControlFrame): frame is GatewayEvent {
  return frame.type !== 'ok' && frame.type !== 'error' && frame.type in EVENT_TYPES;
}
