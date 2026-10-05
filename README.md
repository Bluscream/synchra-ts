# synchra-ts

A TypeScript client for the [Synchra](https://synchra.net) API: complete REST coverage, the realtime
gateway, and no runtime dependencies.

```bash
npm install synchra-ts
```

```ts
import { Synchra, MessageContent } from 'synchra-ts';

const synchra = Synchra.fromEnvironment(); // reads SYNCHRA_TOKEN

const page = await synchra.channel.getChannels();
const channel_id = page.records[0]?.id ?? '';

const stream = synchra.events();

stream.on('chat_message', (event) => {
  // `event.data` is a ChatMessage — inferred from the string you subscribed to, no cast.
  console.log(
    event.data.viewer_display_name,
    MessageContent.plainText(MessageContent.contentParts(event.data)),
  );
});

stream.subscribe('chat_message', { channel_id });
await stream.connect();
```

|                      |                                            |
| :------------------- | -----------------------------------------: |
| Operations           |         **241**, across 42 endpoint groups |
| Schemas              | **469** interfaces, aliases and value sets |
| Gateway event types  |                                     **13** |
| Runtime dependencies |                                      **0** |
| Tests                |                            140, no network |

Requires Node 20 or newer, Bun, Deno, or a browser — anything with `fetch`. The gateway also needs
`WebSocket`, which Node has had since 22; on 20, pass one in (see [The gateway](#the-gateway)).

## What it is generated from

Not from `https://api.synchra.net/openapi.json` directly. From that document **plus an annotation
overlay**, both of which live in [synchra-api](https://github.com/Bluscream/synchra-api).

The published description has a `description` on **1 of its 240 operations** and generates every
`summary` from a function name, and across all of them the only documented failure is `422`. A client
generated faithfully from it would have no error model and no idea that a notice puts its content
somewhere else. The overlay supplies what it leaves unsaid, and `tools/fetch-spec.sh` applies it
while fetching, so those notes land in the doc comments — where you read them at the call site rather
than after the bug.

What that buys, concretely:

- `getActivities()` says a **403 usually means the token is not granted on _that channel_**, not that
  a scope is missing.
- `ChatMessage` says a notice leaves `message_parts` **empty**.
- Nine operations are marked as needing no credential, each verified with an unauthenticated request.
- `GET /health` and `GET /api/2/ws` exist as methods and types, though the published document lists
  neither.
- Four gateway payloads — `KvEventData`, `ChannelGiveawaysEventData`, `QueueEvent`,
  `ActivityAlertWidgetTest` — have real types, though only the WebSocket reference names them.

```bash
./tools/fetch-spec.sh    # refresh spec/ from the live API, overlay applied
npm run generate         # rebuild src/generated/
```

Both the description and the gateway reference are vendored in `spec/` and committed, so a build
needs no network and `git diff` after a refresh shows exactly how the API changed. A **removal** is
the case to watch for: a generated client keeps compiling against a route that now 404s. Between
April and October 2026, 102 paths appeared and 31 disappeared — use
[`tools/diff-spec.sh`](https://github.com/Bluscream/synchra-api) from synchra-api, which exits
non-zero when anything was removed.

## Calling an endpoint

Every method takes **one options object**, with the API's own `snake_case` names, so a value read off
a model goes straight into the next call:

```ts
const activity = await synchra.channelActivity.getActivity({
  channel_id: channel.id,
  activity_id: id,
});

const filtered = await synchra.channelActivity.getActivities({
  channel_id: channel.id,
  type: ['tiktok_gift', 'sub'],
  per_page: 100,
  signal: controller.signal, // every method accepts signal, headers and retry
});
```

One object rather than positional arguments is not only ergonomics — it is why this generator does
not care what order the description's keys are in. See
[Why the description is key-sorted here](#why-the-description-is-key-sorted-here).

### Pagination

A paged endpoint returns the page as the API sends it — `{ records, cursor, total }`. `paginate`
walks it, lazily:

```ts
import { paginate } from 'synchra-ts';

for await (const activity of paginate((cursor) =>
  synchra.channelActivity.getActivities({ channel_id, cursor, per_page: 100 }),
)) {
  console.log(activity.type_display_name);
}
```

A cursor the API repeats stops the walk with an error rather than looping forever. That is not
hypothetical: a filter whose results change between requests can produce a cursor pointing at a page
it already returned.

### Errors

Every failure throws. The class says which:

```ts
import { ApiError, AuthorizationError, RateLimitError } from 'synchra-ts';

try {
  await synchra.channelActivity.getActivities({ channel_id });
} catch (error) {
  if (error instanceof AuthorizationError) {
    // 403. Usually the token is not granted on *this channel* — check which channels it covers
    // before widening its scopes.
  } else if (error instanceof RateLimitError) {
    await sleep(error.retryAfterMs ?? 1000);
  } else if (error instanceof ApiError) {
    console.error(error.status, error.problems); // `problems` is the per-field detail of a 422
  }
}
```

`SynchraError` catches everything this package throws, `ApiError` everything the service answered.
**None of these statuses are in the published description** — it documents no failure but `422` — so
this model was built from live responses, by way of the overlay.

Retries are automatic on `429` and `5xx`, honouring `Retry-After`, **for idempotent methods only**.
`POST` and `PATCH` are left out deliberately: a `429` is answered before the handler runs, but a
`502` from a proxy can arrive after it did, and retrying that creates a second resource.

### Anonymous access

Nine operations answer without a credential — a channel's providers and provider-streams, its chat
messages and chat events, and the global reference lists:

```ts
const synchra = Synchra.anonymous();
const page = await synchra.chat.getChatMessages({ channel_id, per_page: 40 });
```

Anything else answers `401` as an `AuthenticationError`. The published document cannot tell you
which nine: `security: []` means "needs no credential", 36 operations omit `security` entirely, and
that means something else. The overlay marks the nine, so each one's doc comment says so.

### Tokens

Tokens come from the Synchra dashboard. **`POST /api/2/auth/token` does not exist**, despite the
description declaring an `OAuth2` scheme — its `flows` object is empty, so the scheme names a
mechanism the service does not expose. There is nothing to refresh against.

```ts
Synchra.withToken(token);
Synchra.fromEnvironment(); // SYNCHRA_TOKEN, read per request
Synchra.anonymous();
Synchra.withTokenProvider(async () => vault.read('synchra')); // called per request
```

A token carries a fixed scope set _and_ a fixed set of channels. A full-access token still answers
`403` on a channel it was not granted on.

## The gateway

```ts
const stream = synchra.events();

const off = stream.on('activity', (event) => {
  if (event.action === 'new') {
    console.log(event.data.viewer_display_name, event.data.type_display_name);
  }
});

stream.subscribe('activity', { channel_id });
await stream.connect();

// …later
off();
stream.close(); // closes the socket, the keepalive interval and any reconnect timer
```

- **The handler's payload is inferred** from the event type you name. `on('chat_message', …)` gives a
  `ChatMessage`, `on('activity', …)` an `Activity`, with no cast and no overload per event.
- **Subscriptions survive a reconnect.** They are remembered and replayed on the new socket, so a
  dropped connection restores itself without the caller noticing.
- **`action` matters.** The same event type arrives for a creation, an edit and a deletion; a handler
  that ignores it renders a deletion as a new message.
- **A throwing handler does not take the socket down.** It is reported to `gateway.onError` and the
  loop continues — one bad message must not end a reader meant to run for days.
- **The keepalive is not JSON.** The socket accepts the bare text `ping` and answers with the bare
  text `pong`. A client that pipes every frame through a parser throws on its own heartbeat; this one
  does not.
- `for await (const event of stream.events())` is there too, with a bounded queue that drops the
  oldest rather than growing without end.
- **A subscribe is fire-and-forget unless you ask for an acknowledgement.** Pass a nonce —
  `subscribe('chat_message', { channel_id }, 'sub-1')` — and the gateway answers an `ok` control
  frame carrying it back, or an `error` one naming what was wrong. Without it, a typo in the event
  type is silently nothing. The nonce is replayed after a reconnect, so a watcher sees it again.

One payload is `unknown`: the reference types `channel_giveaway`'s `data` as `any`, so there is
nothing to map it to. Guessing a shape there is how a client ends up asserting a type the service does
not send.

On Node 20 there is no global `WebSocket`:

```ts
const synchra = Synchra.fromEnvironment({
  gateway: { webSocket: (await import('ws')).WebSocket },
});
```

## Rendering chat

Synchra resolves rich content server-side: an emote arrives carrying its CDN urls at three sizes, a
gift carries its name and image, a mention carries the resolved display name. `MessageContent`
collapses the typed parts into one ordered list of segments, so a renderer walks it once:

```ts
const parts = MessageContent.contentParts(message); // not just message_parts — see below

for (const segment of MessageContent.segments(parts, 'lg')) {
  if (segment.imageUrl !== undefined) {
    draw(segment.imageUrl, segment.text); // text is the alt: the emote's name, or the gift's
  } else if (segment.href !== undefined) {
    link(segment.href, segment.text);
  } else {
    write(segment.text);
  }
}
```

`contentParts` exists because **a notice puts its content in `notice_message_parts` and leaves
`message_parts` empty**. A TikTok gift is the common case, and a renderer reading only the first field
draws every one of them as a blank row — on a live channel that was 35 of 200 messages silently
disappearing. `examples/04-render-chat.ts` turns the output into HTML.

It returns data, not markup, so the same helper serves a page, a terminal and a desktop app.
`profileUrl(message)` is the other half: the API carries no public profile url, because the url is a
property of the platform, and YouTube goes by channel id while everyone else goes by handle.

## Deliberate tradeoffs

Things that might look like oversights.

**Property names are the API's `snake_case`.** A decoded response _is_ the interface — nothing is
renamed on the way in, so nothing has to be renamed on the way out, and a field you read in the
network tab is the field you write in code. Camel-casing 469 schemas would mean a translation layer
in both directions and a name that matches neither the API nor its documentation.

**Timestamps stay ISO 8601 strings.** Reviving them into `Date` would mean the decoded body is no
longer the JSON that arrived: it could not be sent back unchanged, a `Date` loses the sub-second
precision the API sends, and every consumer would have to know which fields were rewritten.
`new Date(value)` is one call away.

**No runtime validation.** The types describe what the API documents; they are not enforced at
runtime, because validating 469 schemas on every response would cost more than it catches and would
reject fields the service adds. If you need the guarantee, parse at your own boundary.

**Value sets are not closed.** The description models some fields as a union of several platforms'
enums, and the service sends values that are in none of them. Where the description says so, the type
is an `OpenEnum<…>` — the known members stay suggested in an editor while any string is still
accepted. Treat an unrecognised value as data to pass through, not as impossible.

**A named value set is an `as const` object, not an `enum`.** A TypeScript `enum` has runtime
semantics that do not erase, and an enum member is not assignable from the plain string the API
sends.

**`groups` is a namespace.** Six of the 42 endpoint-group classes share a name with a schema —
`Channel` is both a tag and a model — so the models hold the flat export namespace, and the classes
are `groups.Channel`. You rarely need them: `synchra.channel` is the group.

## Why the description is key-sorted here

`tools/fetch-spec.sh` normalises the document with `jq --sort-keys`. The API does not promise a stable
key order, and without normalising, two fetches of an _unchanged_ document produce a diff thousands of
lines long with the real change hidden in it.

[synchra-php](https://github.com/Bluscream/synchra-php) deliberately does **not** do this, because
there key order leaks into the generated API: a generator naturally names an inline enum after the
first property that references it, and emits constructor parameters in the order the properties
appear. Measured: sorting renamed two enums, dropped a union, and reordered the constructors of **290**
models — a breaking change for anyone constructing a model positionally.

This generator has neither property. An inline enum becomes an inline literal union with no name at
all, every method takes one options object rather than positional arguments, and the emitters sort
what they write. `test/generator.test.ts` generates the whole tree twice — once from a key-sorted copy
of the description and once from a key-reversed one — and asserts the output is byte-identical, so the
claim is checked rather than asserted.

## Development

```bash
npm install
npm run check      # format, lint, typecheck, test, build — the whole gate

./tools/fetch-spec.sh   # refresh spec/ from the live API
npm run generate        # rebuild src/generated/, then review the diff
```

`src/generated/` is committed and wiped on every run, so an endpoint the API has removed disappears
instead of lingering. Everything else under `src/` is hand-written. The generator lives in
`tools/generator/` and has its own tests.

The live suite in `test/live.test.ts` is **read-only GETs** and skips unless
`SYNCHRA_PUBLIC_CHANNEL_ID` (and optionally `SYNCHRA_TOKEN`) is set, so `npm test` on a clean checkout
needs no network and no credentials.

CI is `workflow_dispatch` only — see the comment at the top of
[`.github/workflows/check.yml`](.github/workflows/check.yml).

## Related

|                                                         |                                                              |
| :------------------------------------------------------ | :----------------------------------------------------------- |
| [synchra-api](https://github.com/Bluscream/synchra-api) | the API description, the annotation overlay, and the caveats |
| [synchra-php](https://github.com/Bluscream/synchra-php) | the PHP client, generated from the same overlay              |

`docs/CAVEATS.md` in synchra-api is worth reading before building anything on this API: it is the
list of things the description does not tell you and that cost somebody an afternoon.

## Licence

MIT, for this repository's own code. `spec/` is Synchra's own published API description, reproduced
for interoperability; it belongs to Synchra and is not the authors' to license.

No credentials are in this repository and none belong here. `.gitignore` excludes `*.har`, because a
dashboard capture carries live bearer tokens.
