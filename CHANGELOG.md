# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-05

First release. Complete coverage of the Synchra API v2 as described by
`https://api.synchra.net/openapi.json` **plus the annotation overlay from
[synchra-api](https://github.com/Bluscream/synchra-api)**, both vendored in `spec/`.

### Added

- **Full REST coverage** — 241 operations across 42 endpoint groups, each a method on
  `Synchra`. 469 schemas as interfaces, type aliases and `as const` value sets, all generated from
  the API description by `tools/generate.ts`. Every method takes one options object using the API's
  own `snake_case` names.
- **Realtime gateway** — `EventStream`, covering all 13 event types. The handler's payload is
  inferred from the event type it subscribed to, subscriptions are replayed across a reconnect, and a
  throwing handler is reported rather than taking the socket down. Usable with callbacks or as an
  async iterable.
- **An error model the published description does not have.** Across its 240 operations the only
  documented failure is `422`; there is no `401`, `403`, `404`, `429` or `5xx` anywhere. One class per
  status, built from live responses and supplied to the generated layer by the overlay, each carrying
  the API's error envelope and a 422's per-field problems.
- **The annotations in the doc comments.** Synchra fills `description` on 1 of its 240 operations and
  generates every `summary` from a function name, so there is nowhere in the document for the things
  that cost an afternoon. `getActivities()` says that a 403 usually means the token is not granted on
  _that channel_; `ChatMessage` says that a notice empties `message_parts`.
- **Pluggable credentials** — `staticToken`, `environmentToken`, `anonymousToken`, or any function.
  Read per request, so a rotating token reaches the next call without rebuilding the client. The API
  has no token endpoint; tokens come from the dashboard.
- **`Synchra.anonymous()`** for the nine operations that answer without a credential, each verified
  with an unauthenticated request. The published document cannot express this: `security: []` means
  "needs none" and 36 operations omit `security` entirely, which means something else.
- **Cursor pagination** — `paginate()` as an async generator, lazy, and refusing to loop on a cursor
  the API repeats.
- **Retries** — exponential backoff on 429 and 5xx, honouring `Retry-After`, for idempotent methods
  only.
- **`MessageContent`** — resolves a chat message's or activity's rich content into drawable segments
  and badges. `contentParts()` reads whichever list carries the content, because a notice puts
  everything in `notice_message_parts` and leaves `message_parts` empty — on a live channel that was
  35 of 200 messages rendering as blank rows.
- **`profileUrl()`** — a viewer's public profile url on the platform they wrote from, including that
  YouTube goes by channel id while everyone else goes by handle. A provider that is not somewhere
  people have profiles answers `undefined` rather than a guess.
- **`synchra.service.health()`** — `GET /health`, which the service answers and the published
  description does not list. It _was_ listed in April 2026 and was removed from the description, not
  from the service.
- **Zero runtime dependencies.** `fetch` and `WebSocket` are the platform's; both are replaceable for
  a proxy, instrumentation or a test double.
- **Tests** — 133 unit tests with no network, including structural coverage asserting that every
  operation in the description is reachable _and_ that no method exists without an operation behind
  it. A read-only live suite skips without `SYNCHRA_PUBLIC_CHANNEL_ID`.

### Notes

- `GET /api/2/ws` is in the description — the overlay puts it there, so the gateway is discoverable —
  but generates no method: a `101` response means the request is a protocol upgrade, and over plain
  HTTP that route answers `426`.
- `tools/fetch-spec.sh` normalises the description with `jq --sort-keys`, which synchra-php
  deliberately does not. `test/generator.test.ts` asserts the invariance that makes it safe by
  generating the tree from a key-sorted and a key-reversed document and comparing the output.
- One gateway payload is `unknown`: the reference types `channel_giveaway`'s `data` as `any`.
- TypeScript runs with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; ESLint
  with `strictTypeChecked`. One rule is disabled, for `src/generated/` only, with the reason in
  `eslint.config.mjs`.
- See **Deliberate tradeoffs** in the README for the decisions that might look like oversights:
  `snake_case` properties, ISO 8601 strings rather than `Date`, and no runtime validation.

[0.1.0]: https://github.com/Bluscream/synchra-ts/releases/tag/v0.1.0
