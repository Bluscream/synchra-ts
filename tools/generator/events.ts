/**
 * Generates the realtime gateway's typed surface from `spec/websocket.md`.
 *
 * The gateway is documented separately from the OpenAPI description — it has its own reference
 * served at `/api/2/ws-docs` — so this reads the tables out of that document: which event types
 * exist, what each one subscribes with, and which schema its payload carries.
 *
 * The output is two maps keyed by event type, which is what lets `stream.on('chat_message', …)`
 * infer the handler's payload without a cast or an overload per event.
 *
 * All four payloads the reference names but the published OpenAPI document does not define —
 * `KvEventData`, `ChannelGiveawaysEventData`, `QueueEvent` and `ActivityAlertWidgetTest` — are
 * supplied by the annotation overlay, so they resolve like any other schema. A payload that still
 * does not resolve maps to `unknown`, which is the right answer for an event type Synchra has added
 * and nobody has described yet.
 */
import { docComment, type Emitter } from './emitter.js';
import { propertyKey, schemaType } from './names.js';
import type { Spec } from './spec.js';
import { literal } from './types.js';

interface SubscribeField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

interface GatewayEvent {
  readonly type: string;
  readonly description: string;
  readonly payload: string;
  readonly subscribe: readonly SubscribeField[];
}

export interface EventsResult {
  readonly count: number;
}

export async function emitEvents(
  emitter: Emitter,
  spec: Spec,
  markdown: string,
): Promise<EventsResult> {
  const events = parseEvents(markdown, spec);

  if (events.length === 0) {
    throw new Error('Found no event types in spec/websocket.md.');
  }

  const payloadMap = events
    .map(
      (event) =>
        `${docComment(eventDoc(event), '  ')}  ${propertyKey(event.type)}: ${event.payload};`,
    )
    .join('\n');

  const subscribeMap = events
    .map((event) => {
      const fields = event.subscribe
        .map(
          (field) =>
            `    ${propertyKey(field.name)}${field.required ? '' : '?'}: ${field.required ? field.type : `${field.type} | undefined`};`,
        )
        .join('\n');

      return `${docComment([`What \`${event.type}\` subscribes with.`], '  ')}  ${propertyKey(event.type)}: {\n${fields}\n  };`;
    })
    .join('\n');

  const constants = events.map((event) => `  ${propertyKey(event.type)}: ${literal(event.type)},`);

  const rendered = `${payloadMap}\n${subscribeMap}`;

  const body = [
    docComment([
      'The realtime gateway’s event types, their payloads and what each subscribes with.',
      '',
      'Read from `spec/websocket.md`, which is the gateway’s own reference — the OpenAPI document',
      'describes the socket as a single `GET /api/2/ws` and says nothing about what travels over it.',
    ]),
    rendered.includes('Models.') ? "import type * as Models from './models.js';" : '',
    `${docComment(['Every event type the gateway sends.'])}export const EVENT_TYPES = {\n${constants.join('\n')}\n} as const;\n`,
    `${docComment(['One of the gateway’s event types.'])}export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];\n`,
    `${docComment([
      'What happened to the record the event carries.',
      '',
      'The same event type arrives for a creation, an edit and a deletion — a deleted chat message',
      'is a `chat_message` event with `action: "deleted"`, not a separate type — so a handler that',
      'ignores this renders a deletion as a new message.',
    ])}export const EVENT_ACTIONS = ['new', 'updated', 'deleted'] as const;\n\nexport type EventAction = (typeof EVENT_ACTIONS)[number];\n`,
    `${docComment([
      'The payload each event type carries.',
      '',
      'Keyed by event type so a handler’s argument is inferred from the type it subscribed to.',
    ])}export interface EventPayloads {\n${payloadMap}\n}\n`,
    `${docComment([
      'The data each event type subscribes with.',
      '',
      'These are the gateway’s own subscribe fields, not query parameters: `widget_value` needs',
      'three of them, most need only a channel.',
    ])}export interface SubscribeData {\n${subscribeMap}\n}\n`,
    `${docComment([
      'One event as it arrives on the socket.',
      '',
      '`nonce` is echoed back from the command that caused it, where there was one.',
    ])}export interface GatewayEvent<T extends EventType = EventType> {\n  type: T;\n  action: EventAction;\n  data: EventPayloads[T];\n  nonce?: string | null | undefined;\n}\n`,
  ]
    .filter((part) => part !== '')
    .join('\n\n');

  await emitter.write('src/generated/events.ts', body);

  return { count: events.length };
}

function eventDoc(event: GatewayEvent): string[] {
  const lines = event.description === '' ? [] : [event.description];
  const keys = event.subscribe.map((field) => `\`${field.name}\``).join(', ');

  if (keys !== '') {
    lines.push('', `Subscribes with ${keys}.`);
  }

  return lines;
}

function parseEvents(markdown: string, spec: Spec): GatewayEvent[] {
  const types = eventTypeTable(markdown);
  const events: GatewayEvent[] = [];

  for (const type of types) {
    const section = sectionFor(markdown, type);

    events.push({
      type,
      description: firstLine(section),
      payload: payloadType(section, spec),
      subscribe: subscribeFields(section),
    });
  }

  return events;
}

/** The event types, in the order the reference lists them. */
function eventTypeTable(markdown: string): string[] {
  const table = /## Event Types\n\n\|[^\n]*\n\|[^\n]*\n((?:\|[^\n]*\n)+)/.exec(markdown);

  if (table === null) {
    throw new Error('Could not find the Event Types table in spec/websocket.md.');
  }

  const types: string[] = [];

  for (const line of (table[1] ?? '').trim().split('\n')) {
    const first = cells(line)[0];

    if (first !== undefined && first !== '') {
      types.push(first);
    }
  }

  return types;
}

function sectionFor(markdown: string, type: string): string {
  const pattern = new RegExp(`\\n## \`${escapeRegExp(type)}\`\\n([\\s\\S]*?)(?=\\n## \`|$)`);
  const found = pattern.exec(markdown);

  if (found === null) {
    throw new Error(`No section for the "${type}" event in spec/websocket.md.`);
  }

  return found[1] ?? '';
}

/**
 * The payload type from the Event Envelope table's `data` row.
 *
 * A cell naming a schema the description defines becomes that type. `[]` in the cell makes it a
 * list. Anything else — `any`, `object` — stays `unknown`, because guessing a shape here is how a
 * client ends up asserting a type the service does not send.
 */
function payloadType(section: string, spec: Spec): string {
  const row = /\n\| `data` \| ([^|]+)\|/.exec(section);

  if (row === null) {
    return 'unknown';
  }

  const cell = (row[1] ?? '').trim();
  const names = [...cell.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => !['any', 'null', 'string', 'object'].includes(name));

  const resolved = names.filter((name) => spec.has(name)).map((name) => `Models.${schemaType(name)}`);

  if (resolved.length === 0) {
    return 'unknown';
  }

  const union = [...new Set(resolved)].join(' | ');
  const type = resolved.length > 1 ? `(${union})` : union;

  return cell.includes('[]') ? `${type}[]` : type;
}

/** The Subscribe Data table: which fields a subscription takes, and which are required. */
function subscribeFields(section: string): SubscribeField[] {
  const table = /#### Subscribe Data\n\|[^\n]*\n\|[^\n]*\n((?:\|[^\n]*\n)+)/.exec(section);

  if (table === null) {
    return [];
  }

  const fields: SubscribeField[] = [];

  for (const line of (table[1] ?? '').trim().split('\n')) {
    const row = cells(line);
    const name = row[0];

    if (name === undefined || name === '') {
      continue;
    }

    fields.push({
      name,
      type: subscribeFieldType(row[1] ?? ''),
      required: (row[2] ?? '').includes('Yes'),
    });
  }

  return fields;
}

/**
 * The reference writes a subscribe field's type as the API's own name for it.
 *
 * `uuid` is a string on the wire; so is every other type these fields use. Mapping them to `string`
 * rather than inventing a branded type keeps a value read off a model assignable without a cast.
 */
function subscribeFieldType(cell: string): string {
  const names = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
  const mapped = new Set(
    names
      .filter((name) => name !== 'null')
      .map((name) => (name === 'integer' || name === 'number' ? 'number' : 'string')),
  );

  return mapped.size === 0 ? 'string' : [...mapped].join(' | ');
}

function cells(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim().replace(/^`|`$/g, '').trim());
}

function firstLine(section: string): string {
  const line = section.trim().split('\n')[0]?.trim() ?? '';

  return line.startsWith('|') || line.startsWith('#') || line.startsWith('```') ? '' : line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
