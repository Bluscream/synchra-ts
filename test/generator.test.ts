/**
 * Tests the generator against the real description, not a fixture.
 *
 * The description is vendored and committed, so this is deterministic — and it is the only way to
 * check the property the README claims: that the output does not depend on the description's key
 * order.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Spec, isObject } from '../tools/generator/spec.js';
import { typeNames } from '../tools/generator/models.js';
import { generate, readSources } from '../tools/generator/run.js';

const ROOT = join(import.meta.dirname, '..');

/**
 * Recursively sorts every object's keys.
 *
 * The API does not promise a stable key order, so this is the transformation an upstream reorder
 * would amount to.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (!isObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};

  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    out[key] = sortKeys(value[key]);
  }

  return out;
}

/** Reverses every object's key order, which is the other extreme from sorting. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }

  if (!isObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};

  for (const key of Object.keys(value).reverse()) {
    out[key] = reverseKeys(value[key]);
  }

  return out;
}

async function filesIn(root: string): Promise<Map<string, string>> {
  const directory = join(root, 'src/generated');
  const out = new Map<string, string>();

  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        await walk(path);
      } else {
        out.set(path, await readFile(join(directory, path), 'utf8'));
      }
    }
  };

  await walk('');

  return out;
}

describe('the generator', () => {
  let sources: Awaited<ReturnType<typeof readSources>>;

  beforeAll(async () => {
    sources = await readSources(ROOT);
  });

  it('covers every operation the description declares', () => {
    expect(sources.spec.operations.length).toBe(241);
    expect(sources.spec.schemas.size).toBe(469);
  });

  it('skips the gateway, whose 101 response is a protocol upgrade rather than a call', () => {
    const paths = sources.spec.operations.map((operation) => operation.path);

    // The overlay puts `GET /api/2/ws` in the document deliberately, so a reader can see the socket
    // exists. Generating a method for it would offer a call that answers 426 over plain HTTP.
    expect(paths).not.toContain('/api/2/ws');
    expect(paths).toContain('/health');
  });

  it('rejects two schemas that would map to one type name', () => {
    const document = structuredClone(sources.spec.document);
    const schemas = isObject(document.components) ? document.components.schemas : undefined;

    expect(isObject(schemas)).toBe(true);

    if (isObject(schemas)) {
      // `-Input` normalises away, so this is the collision that already nearly happened.
      schemas.KvJsonValueInput = { type: 'string' };
    }

    expect(() => typeNames(new Spec(document))).toThrow(/both map to the type name/);
  });

  describe('is insensitive to the description’s key order', () => {
    const roots: string[] = [];

    const generateInto = async (
      transform: (value: unknown) => unknown,
    ): Promise<Map<string, string>> => {
      const root = await mkdtemp(join(tmpdir(), 'synchra-ts-generate-'));

      roots.push(root);

      const document = transform(sources.spec.document);

      expect(isObject(document)).toBe(true);

      await generate({
        outputRoot: root,
        spec: new Spec(isObject(document) ? document : {}),
        markdown: sources.markdown,
      });

      return filesIn(root);
    };

    afterAll(async () => {
      for (const root of roots) {
        await rm(root, { recursive: true, force: true });
      }
    });

    /**
     * This is the property that lets tools/fetch-spec.sh normalise the description with
     * `jq --sort-keys`, which synchra-php cannot do: there, key order picks inline-enum class names
     * and constructor parameter order, so sorting renamed two enums, dropped a union and reordered
     * 290 constructors. Asserting it here rather than claiming it in a comment is the whole point.
     */
    it('produces identical output from a sorted and a reversed document', async () => {
      const sorted = await generateInto(sortKeys);
      const reversed = await generateInto(reverseKeys);

      expect([...reversed.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
        [...sorted.keys()].sort((a, b) => a.localeCompare(b)),
      );

      for (const [name, contents] of sorted) {
        expect(reversed.get(name), `${name} differs between key orders`).toBe(contents);
      }
    }, 60_000);

    it('reproduces the committed files', async () => {
      const fresh = await generateInto((value) => value);
      const committed = await filesIn(ROOT);

      // The committed tree is Prettier-formatted by `npm run generate`, which this does not run, so
      // only the set of files is compared here. `npm run generate` plus a clean `git diff` is what
      // checks the contents, and CI does exactly that.
      expect([...fresh.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
        [...committed.keys()].sort((a, b) => a.localeCompare(b)),
      );
    }, 60_000);
  });
});
