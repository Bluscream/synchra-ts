/**
 * Structural checks: that the generated surface actually covers the description.
 *
 * This is the test that notices a dropped route. A generated client keeps compiling against a method
 * whose endpoint has gone, and keeps *missing* one that was added — neither shows up in a type check,
 * so it has to be asserted against the description itself.
 */
import { describe, expect, it } from 'vitest';

import { ApiClient } from '../src/client.js';
import { anonymousToken, environmentToken, staticToken } from '../src/auth.js';
import { EVENT_TYPES } from '../src/generated/events.js';
import { Resources } from '../src/generated/resources/index.js';
import { Synchra } from '../src/synchra.js';
import { camel, operationMethod, tagClass } from '../tools/generator/names.js';
import { readSources } from '../tools/generator/run.js';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const { spec, markdown } = await readSources(ROOT);

const resources = new Resources(new ApiClient(staticToken(null)));

/** Every method name on one group, excluding the constructor. */
function methodsOf(group: object): Set<string> {
  const prototype = Object.getPrototypeOf(group) as object;

  return new Set(
    Object.getOwnPropertyNames(prototype).filter(
      (name) =>
        name !== 'constructor' && typeof (group as Record<string, unknown>)[name] === 'function',
    ),
  );
}

describe('endpoint coverage', () => {
  it('reaches every tag of the description from the facade', () => {
    const tags = new Set(spec.operations.map((operation) => tagClass(operation.tag)));
    const reachable = new Set(Object.keys(resources));

    for (const tag of tags) {
      expect(reachable, `no accessor for the ${tag} group`).toContain(camel(tag));
    }

    expect(reachable.size).toBe(tags.size);
  });

  it('reaches every operation as a method on its group', () => {
    const missing: string[] = [];

    for (const operation of spec.operations) {
      const group = (resources as unknown as Record<string, object>)[
        camel(tagClass(operation.tag))
      ];

      if (group === undefined) {
        missing.push(`${operation.method} ${operation.path} — no group`);

        continue;
      }

      const expected = operationMethod(
        operation.method,
        operation.path,
        operation.summary !== '' ? operation.summary : operation.operationId,
      );
      const methods = methodsOf(group);

      // A tag whose summaries are not unique gets a numeric suffix, so a near miss counts: the
      // point is that *an* operation of that name exists, not which suffix it landed on.
      const found = [...methods].some(
        (name) => name === expected || new RegExp(`^${expected}\\d+$`).test(name),
      );

      if (!found) {
        missing.push(`${operation.method} ${operation.path} — expected ${expected}()`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('declares exactly as many methods as the description has operations', () => {
    const total = Object.values(resources).reduce(
      (sum: number, group) => sum + methodsOf(group as object).size,
      0,
    );

    // Equal in both directions: a method with no operation behind it would 404, and an operation
    // with no method is unreachable.
    expect(total).toBe(spec.operations.length);
  });

  it('covers every gateway event type the reference lists', () => {
    // Scoped to the Event Types table: the Commands table above it has the same row shape, and
    // `ping` is a command rather than an event.
    const table = /## Event Types\n\n\|[^\n]*\n\|[^\n]*\n((?:\|[^\n]*\n)+)/.exec(markdown);
    const listed = [...(table?.[1] ?? '').matchAll(/^\| `([a-z_]+)` \|/gm)].map(
      (match) => match[1],
    );

    expect(listed).toHaveLength(13);

    for (const type of listed) {
      expect(Object.keys(EVENT_TYPES)).toContain(type);
    }
  });
});

describe('the facade', () => {
  it('exposes the groups, the client and the gateway', () => {
    const synchra = Synchra.anonymous();

    expect(synchra.api).toBeInstanceOf(ApiClient);
    expect(synchra.channel).toBeDefined();
    expect(synchra.events()).toBe(synchra.events());
  });

  it('reuses one gateway, so handlers stay registered', () => {
    const synchra = Synchra.withToken('t');
    const stream = synchra.events();

    stream.subscribe('activity', { channel_id: 'a' });

    expect(synchra.events().subscribed()).toHaveLength(1);
  });

  it('reads SYNCHRA_TOKEN at each call rather than at construction', async () => {
    const before = process.env.SYNCHRA_TOKEN;

    try {
      delete process.env.SYNCHRA_TOKEN;

      // Built while the variable is unset, so a provider that captured it once would answer null
      // for the rest of the process.
      const token = environmentToken();

      expect(await token()).toBeNull();

      process.env.SYNCHRA_TOKEN = 'set-afterwards';

      expect(await token()).toBe('set-afterwards');
    } finally {
      if (before === undefined) {
        delete process.env.SYNCHRA_TOKEN;
      } else {
        process.env.SYNCHRA_TOKEN = before;
      }
    }
  });

  it('sends no credential on an anonymous client', async () => {
    expect(await anonymousToken()).toBeNull();
    expect(await staticToken('')()).toBeNull();
    expect(await staticToken(undefined)()).toBeNull();
  });
});
