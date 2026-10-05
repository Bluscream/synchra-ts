/**
 * Emits the description's named closed value sets.
 *
 * Only the *named* ones. An enum the description declares inline — `"activity_group": {"enum":
 * [...]}` — becomes an inline literal union on the property, with no name and no declaration: that
 * is what TypeScript's structural types buy, and it removes the step where synchra-php has to
 * invent a name from the first property that happens to reference the set. Which property that is
 * depends on key order, which is why sorting the description renames classes there and nothing
 * here.
 *
 * Each named set is emitted twice over: an `as const` object so the values exist at runtime, and a
 * union type of its members. `enum` itself is deliberately not used — it has runtime semantics that
 * do not erase, and a TypeScript `enum` member is not assignable from the string the API sends.
 */
import { docComment, type Emitter } from './emitter.js';
import { pascal } from './names.js';
import { isArray, type JsonObject, type Spec } from './spec.js';
import { literal } from './types.js';
import { schemaDoc, typeNames } from './models.js';

export interface EnumsResult {
  /** The emitted type names, for models.ts to import the ones it uses. */
  readonly types: ReadonlySet<string>;
  readonly count: number;
}

export async function emitEnums(emitter: Emitter, spec: Spec): Promise<EnumsResult> {
  const names = typeNames(spec);
  const declarations: string[] = [];
  const types = new Set<string>();

  for (const [name, emitted] of names) {
    const schema = spec.schema(name);
    const values = schema.enum;

    if (!isArray(values)) {
      continue;
    }

    declarations.push(render(emitted, schema, values));
    types.add(emitted);
  }

  const body = [
    docComment([
      'The named closed value sets in the API description.',
      '',
      'Each is an `as const` object plus a union of its members, so the values are usable at',
      'runtime (`ChatMessageType.notice`) and the type is assignable from the plain string the API',
      'sends. A TypeScript `enum` would be neither.',
      '',
      '**These sets are not closed in practice.** The description models some fields as a union of',
      'several platforms’ enums and the service will send a value that is in none of them, so a',
      'decoded response can hold a string this union does not list. Treat an unrecognised value as',
      'data to pass through rather than as impossible.',
    ]),
    declarations.join('\n'),
  ].join('\n\n');

  await emitter.write('src/generated/enums.ts', body);

  return { types, count: types.size };
}

function render(name: string, schema: JsonObject, values: readonly unknown[]): string {
  const members: string[] = [];
  const taken = new Set<string>();

  for (const value of values) {
    const key = memberName(value, taken);

    taken.add(key);
    members.push(`  ${key}: ${literal(value)},`);
  }

  const doc = docComment(schemaDoc(schema, name));

  return (
    `${doc}export const ${name} = {\n${members.join('\n')}\n} as const;\n\n` +
    `${doc}export type ${name} = (typeof ${name})[keyof typeof ${name}];\n`
  );
}

/**
 * A property name for one wire value.
 *
 * The wire value itself where it is already a valid identifier — `ChatMessageType.notice` reads
 * better than `ChatMessageType.Notice` and needs no mental mapping back to the string — and a
 * normalised form otherwise.
 */
export function memberName(value: unknown, taken: ReadonlySet<string>): string {
  const candidate = baseMemberName(value);
  const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(candidate) ? candidate : JSON.stringify(candidate);

  if (!taken.has(safe)) {
    return safe;
  }

  for (let suffix = 2; ; suffix += 1) {
    const next = `${safe}${String(suffix)}`;

    if (!taken.has(next)) {
      return next;
    }
  }
}

function baseMemberName(value: unknown): string {
  if (typeof value === 'number') {
    return value < 0 ? `neg${String(Math.abs(value))}` : `n${String(value)}`;
  }

  if (typeof value !== 'string') {
    return String(value);
  }

  if (value === '') {
    return 'empty';
  }

  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    return value;
  }

  const normalised = pascal(value);

  return normalised === 'Unnamed'
    ? value
    : normalised.charAt(0).toLowerCase() + normalised.slice(1);
}
