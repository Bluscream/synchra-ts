/**
 * synchra-ts — a TypeScript client for the Synchra API.
 *
 * Everything under `generated/` is built from the annotated OpenAPI description by
 * `tools/generate.ts`; everything beside it is written by hand. See the README for which is which
 * and why.
 */

export { Synchra, VERSION, type SynchraOptions } from './synchra.js';

export {
  ApiClient,
  DEFAULT_BASE_URL,
  parseErrorBody,
  type ClientOptions,
  type FetchLike,
  type RequestEvent,
} from './client.js';

export { anonymousToken, environmentToken, staticToken, type TokenProvider } from './auth.js';

export {
  ApiError,
  AuthenticationError,
  AuthorizationError,
  BadRequestError,
  ConfigurationError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  SerializationError,
  ServerError,
  SynchraError,
  TransportError,
  ValidationError,
} from './errors.js';

export {
  DEFAULT_RETRY_POLICY,
  buildQuery,
  cleanHeaders,
  expandPath,
  type ApiRequestSpec,
  type IsoDateTime,
  type OpenEnum,
  type ParamValue,
  type RequestOptions,
  type RetryPolicy,
} from './wire.js';

export { collect, paginate, type CursorPage, type PaginateOptions } from './pagination.js';

export {
  DEFAULT_GATEWAY_URL,
  EventStream,
  isGatewayEvent,
  type ControlFrame,
  type GatewayOptions,
  type WebSocketConstructor,
  type WebSocketLike,
} from './ws/stream.js';

export { type Subscription } from './ws/subscriptions.js';

export {
  EVENT_ACTIONS,
  EVENT_TYPES,
  type EventAction,
  type EventPayloads,
  type EventType,
  type GatewayEvent,
  type SubscribeData,
} from './generated/events.js';

// Every schema the API defines, and every named value set — the latter re-exported through
// models.js, so one import reaches both.
export * from './generated/models.js';

// The options interface for each of the 241 operations, flat.
export * from './generated/resources/params.js';

// The endpoint-group classes under a namespace, not flat: six of the 42 share a name with a schema
// — `Channel` is both a tag and a model — and the models hold the flat namespace because they are
// what a caller handles constantly. Reach a group's class as `groups.Channel`, or just use
// `synchra.channel`.
export * as groups from './generated/resources/index.js';
export { Resources } from './generated/resources/index.js';

export { MessageContent, type Badge, type Segment } from './presentation/message-content.js';

export { profileUrl } from './presentation/profile-url.js';
