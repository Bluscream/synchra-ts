#!/usr/bin/env tsx
/**
 * Builds the generated layer from the vendored API description.
 *
 * Run it with `npm run generate` after `./tools/fetch-spec.sh`. Everything it writes is under
 * `src/generated/`, and that directory is wiped first — so an endpoint the API has removed
 * disappears instead of lingering as a method that now 404s.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, readSources } from './generator/run.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { spec, markdown } = await readSources(root);
const summary = await generate({ outputRoot: root, spec, markdown });

console.log(`Generated ${String(summary.files)} files from spec/openapi.json:`);
console.log(`  ${String(summary.interfaces).padStart(4)} interfaces`);
console.log(`  ${String(summary.aliases).padStart(4)} type aliases`);
console.log(`  ${String(summary.enums).padStart(4)} named value sets`);
console.log(
  `  ${String(summary.groups).padStart(4)} endpoint groups covering ${String(summary.operations)} operations`,
);
console.log(`  ${String(summary.events).padStart(4)} gateway event types`);
