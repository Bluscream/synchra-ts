/**
 * Runs every emitter over one description.
 *
 * Separate from the CLI in tools/generate.ts so the test suite can call it against a modified
 * description and a throwaway output directory — which is how the key-order invariance test works.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Emitter } from './emitter.js';
import { emitEnums } from './enums.js';
import { emitEvents } from './events.js';
import { emitModels } from './models.js';
import { emitResources } from './resources.js';
import { Spec, isObject } from './spec.js';
import { TypeMapper } from './types.js';

export interface GenerateSummary {
  readonly files: number;
  readonly interfaces: number;
  readonly aliases: number;
  readonly enums: number;
  readonly groups: number;
  readonly operations: number;
  readonly events: number;
}

export interface GenerateInput {
  /** Where `src/generated/` is written. */
  readonly outputRoot: string;
  readonly spec: Spec;
  /** The gateway reference, as `spec/websocket.md` holds it. */
  readonly markdown: string;
}

export async function generate(input: GenerateInput): Promise<GenerateSummary> {
  const { outputRoot, spec, markdown } = input;
  const emitter = new Emitter(outputRoot);

  await emitter.wipe('src/generated');

  // Enums first: models.ts refers to them as `Enums.X`, so their names have to be known before it
  // is rendered.
  const enums = await emitEnums(emitter, spec);

  // models.ts names a schema bare and a value set through its namespace import. Everything outside
  // src/generated/models.ts reaches both through `Models`, because models.ts re-exports the value
  // sets — one import, and no collision with a group class of the same name.
  const inModels = new TypeMapper((name) => (enums.types.has(name) ? `Enums.${name}` : name));
  const fromOutside = new TypeMapper((name) => `Models.${name}`);

  const models = await emitModels(emitter, spec, inModels);
  const resources = await emitResources(emitter, spec, fromOutside);
  const events = await emitEvents(emitter, spec, markdown);

  return {
    files: emitter.count(),
    interfaces: models.interfaces,
    aliases: models.aliases,
    enums: enums.count,
    groups: resources.groups.size,
    operations: resources.operations,
    events: events.count,
  };
}

/** Reads the vendored description and gateway reference from a checkout. */
export async function readSources(root: string): Promise<{ spec: Spec; markdown: string }> {
  const parsed: unknown = JSON.parse(await readFile(join(root, 'spec/openapi.json'), 'utf8'));

  if (!isObject(parsed)) {
    throw new Error('spec/openapi.json is not a JSON object.');
  }

  return {
    spec: new Spec(parsed),
    markdown: await readFile(join(root, 'spec/websocket.md'), 'utf8'),
  };
}
