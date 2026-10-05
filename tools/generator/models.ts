/**
 * Emits one declaration per schema in the description: an interface for an object, a type alias for
 * everything else.
 *
 * All of them land in one file. Its length is a property of the API surface rather than of anyone's
 * judgement, and 469 one-interface files would make nothing easier to read — these are types, so
 * they cost nothing at runtime and erase entirely from the build.
 *
 * Properties are emitted required-first then alphabetically, never in the description's own order.
 * That is deliberate: the description does not promise a stable key order, and anchoring the output
 * to it is what makes synchra-php's generator reorder 290 constructors when the keys move.
 */
import { docComment, type Emitter } from './emitter.js';
import { propertyKey, schemaType } from './names.js';
import { isArray, isObject, type JsonObject, type Spec } from './spec.js';
import { DATE_TIME_TYPE, OPEN_ENUM_TYPE, type TypeMapper } from './types.js';

export interface ModelsResult {
  /** Schema name to emitted type name, for the other generators to refer to. */
  readonly names: ReadonlyMap<string, string>;
  readonly interfaces: number;
  readonly aliases: number;
}

/**
 * The emitted type name for every schema, with collisions rejected rather than silently resolved.
 *
 * Two schemas mapping to one identifier would shadow each other and the loser would be whichever
 * came second. `KvJsonValue-Input` already normalises to `KvJsonValueInput`, so a future
 * `KvJsonValueInput` would collide — this is what notices.
 */
export function typeNames(spec: Spec): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Map<string, string>();

  for (const name of [...spec.schemas.keys()].sort((a, b) => a.localeCompare(b))) {
    const emitted = schemaType(name);
    const clash = taken.get(emitted);

    if (clash !== undefined) {
      throw new Error(
        `Schemas "${clash}" and "${name}" both map to the type name ${emitted}. ` +
          'Add an entry to SCHEMA_OVERRIDES in tools/generator/names.ts to separate them.',
      );
    }

    taken.set(emitted, name);
    names.set(name, emitted);
  }

  return names;
}

export async function emitModels(
  emitter: Emitter,
  spec: Spec,
  types: TypeMapper,
): Promise<ModelsResult> {
  const names = typeNames(spec);
  const declarations: string[] = [];
  let interfaces = 0;
  let aliases = 0;

  for (const [name, emitted] of names) {
    const schema = spec.schema(name);

    // A named closed value set gets an `as const` object as well as a type, so its values are
    // reachable at runtime. enums.ts emits both; emitting the type here too would collide.
    if (isArray(schema['enum'])) {
      continue;
    }

    if (isObject(schema['properties'])) {
      declarations.push(renderInterface(emitted, schema, types));
      interfaces += 1;

      continue;
    }

    declarations.push(renderAlias(emitted, schema, types));
    aliases += 1;
  }

  const rendered = declarations.join('\n');

  const body = [
    docComment([
      'Every schema the API description defines.',
      '',
      'Property names are the API’s own `snake_case`, so a decoded response *is* the interface:',
      'nothing is renamed on the way in, and nothing has to be renamed on the way out. Timestamps',
      'stay ISO 8601 strings — see {@link IsoDateTime}.',
      '',
      'The named value sets are re-exported from here, so one import reaches every type the API',
      'defines.',
    ]),
    [
      `import type { ${DATE_TIME_TYPE}, ${OPEN_ENUM_TYPE} } from '../wire.js';`,
      "import type * as Enums from './enums.js';",
      '',
      `export type { ${DATE_TIME_TYPE}, ${OPEN_ENUM_TYPE} };`,
      "export * from './enums.js';",
    ].join('\n'),
    rendered,
  ]
    .filter((part) => part !== '')
    .join('\n\n');

  await emitter.write('src/generated/models.ts', body);

  return { names, interfaces, aliases };
}

function renderInterface(name: string, schema: JsonObject, types: TypeMapper): string {
  const properties = isObject(schema['properties']) ? schema['properties'] : {};
  const required = requiredSet(schema);

  const ordered = Object.keys(properties).sort((a, b) => {
    const byRequired = Number(required.has(b)) - Number(required.has(a));

    return byRequired !== 0 ? byRequired : a.localeCompare(b);
  });

  const lines = ordered.map((wire) => {
    const property = properties[wire];
    const isRequired = required.has(wire);
    const mapped = types.map(property);

    // `| undefined` is spelled out because `exactOptionalPropertyTypes` is on: without it, code
    // that builds a payload by assigning `undefined` to an unset field would not compile.
    const type = isRequired ? mapped : `${mapped} | undefined`;
    const doc = docComment(propertyDoc(property, wire), '  ');

    return `${doc}  ${propertyKey(wire)}${isRequired ? '' : '?'}: ${type};`;
  });

  const doc = docComment(schemaDoc(schema, name));
  const body = lines.length === 0 ? '  [key: string]: never;\n' : `${lines.join('\n')}\n`;

  return `${doc}export interface ${name} {\n${body}}\n`;
}

function renderAlias(name: string, schema: JsonObject, types: TypeMapper): string {
  const doc = docComment(schemaDoc(schema, name));

  return `${doc}export type ${name} = ${types.map(schema)};\n`;
}

export function requiredSet(schema: JsonObject): Set<string> {
  const required = schema['required'];

  return new Set(
    isArray(required) ? required.filter((item): item is string => typeof item === 'string') : [],
  );
}

/**
 * The doc lines for a schema: its description where it has one, its title otherwise.
 *
 * The description is where the annotation overlay lands, so this is the path by which a note
 * written in synchra-api ends up in a caller's editor.
 */
export function schemaDoc(schema: JsonObject, name: string): string[] {
  const description = schema['description'];
  const title = schema['title'];

  if (typeof description === 'string' && description.trim() !== '') {
    return description
      .trim()
      .split('\n')
      .map((line) => line.trimEnd());
  }

  // A FastAPI title is the property name title-cased — "Channel Id" for `channel_id` — so it is
  // only worth emitting when it says something the name does not.
  if (typeof title === 'string' && title.trim() !== '' && !isEchoOfName(title, name)) {
    return [`${title.trim().replace(/\.$/, '')}.`];
  }

  return [];
}

function isEchoOfName(title: string, name: string): boolean {
  const flatten = (value: string): string => value.replace(/[^a-z0-9]/gi, '').toLowerCase();

  return flatten(title) === flatten(name);
}

function propertyDoc(property: unknown, wire: string): string[] {
  if (!isObject(property)) {
    return [];
  }

  const lines = schemaDoc(property, wire);
  const format = property['format'];

  if (format === 'date-time') {
    lines.push('', `An ISO 8601 timestamp. See {@link ${DATE_TIME_TYPE}}.`);
  } else if (typeof format === 'string' && format !== '') {
    lines.push('', `Format: \`${format}\`.`);
  }

  return lines;
}
