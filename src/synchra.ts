/**
 * Entry point for the Synchra API.
 *
 * ```ts
 * import { Synchra } from 'synchra-ts';
 *
 * const synchra = Synchra.fromEnvironment();
 * const me = await synchra.user.getUser();
 *
 * for (const channel of await synchra.channel.getChannels()) {
 *   console.log(channel.display_name);
 * }
 * ```
 *
 * Every endpoint group is a property on this object — `synchra.chat`, `synchra.channelActivity` —
 * and the realtime gateway is {@link Synchra.events}.
 */
import { anonymousToken, environmentToken, staticToken, type TokenProvider } from './auth.js';
import { ApiClient, type ClientOptions } from './client.js';
import { Resources } from './generated/resources/index.js';
import { EventStream, type GatewayOptions } from './ws/stream.js';

/** The package version, sent in no header and used only for diagnostics. */
export const VERSION = '0.1.0';

export interface SynchraOptions extends ClientOptions {
  /** Passed to {@link Synchra.events} when the stream is created. */
  readonly gateway?: GatewayOptions;
}

export class Synchra extends Resources {
  readonly api: ApiClient;

  private stream: EventStream | undefined;

  constructor(
    private readonly token: TokenProvider = anonymousToken,
    private readonly options: SynchraOptions = {},
  ) {
    const api = new ApiClient(token, options);

    super(api);
    this.api = api;
  }

  /**
   * A client that sends a personal access token.
   *
   * Tokens are issued by the Synchra dashboard; there is no token endpoint to get one from. A token
   * carries a fixed scope set *and* a fixed set of channels — a full-access token still answers 403
   * on a channel it was not granted on, which looks exactly like a missing scope and is not one.
   */
  static withToken(token: string | null | undefined, options: SynchraOptions = {}): Synchra {
    return new Synchra(staticToken(token), options);
  }

  /** A client that reads its token from `SYNCHRA_TOKEN` on every request. */
  static fromEnvironment(options: SynchraOptions = {}): Synchra {
    return new Synchra(environmentToken(), options);
  }

  /**
   * A client that sends no credentials.
   *
   * Nine operations answer without one — a channel's providers and provider-streams, its chat
   * messages and chat events, and the global reference lists — each verified against the live API.
   * Anything else answers 401 and arrives as an `AuthenticationError`.
   *
   * The published description cannot tell you which nine: `security: []` means "needs no
   * credential", 36 operations omit `security` entirely, and that means something else. The
   * annotation overlay marks the nine, so a generated method's doc comment says so.
   */
  static anonymous(options: SynchraOptions = {}): Synchra {
    return new Synchra(anonymousToken, options);
  }

  /**
   * A client that calls your own function for the token.
   *
   * The function runs per request, so a token fetched from a secret store or refreshed elsewhere
   * reaches the next call without rebuilding the client.
   */
  static withTokenProvider(token: TokenProvider, options: SynchraOptions = {}): Synchra {
    return new Synchra(token, options);
  }

  /**
   * The realtime gateway.
   *
   * Created on first use and reused afterwards, so handlers registered on it stay registered. Call
   * `close()` on it when you are done — it owns a socket, a keepalive interval and possibly a
   * reconnect timer.
   */
  events(): EventStream {
    return (this.stream ??= new EventStream(this.token, this.options.gateway ?? {}));
  }
}
