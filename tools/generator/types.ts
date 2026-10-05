/**
 * Maps a JSON Schema fragment onto a TypeScript type expression.
 *
 * This is where the whole mapping lives, so the rules are in one place. It is far shorter than the
 * equivalent in synchra-php for a structural reason rather than a stylistic one: TypeScript types
 * are anonymous and structural, so an inline enum becomes an inline literal union and a union of
 * object references becomes `A | B | C` — neither needs a generated name, which is what the PHP
 * generator spends most of its complexity on, and what makes that generator sensitive to the
 * description's key order.
 *
 * Anything the description leaves genuinely open maps to `unknown`, never `any`: a caller then has
 * to narrow it, which is the honest requirement.
 */
import { isArray, isObject, refName, type JsonObject } from './spec.js';
import { schemaType } from './names.js';

/** An ISO 8601 timestamp, as the API sends it. */
export const DATE_TIME_TYPE = 'IsoDateTime';

/** The helper that keeps the known members of a value set the description leaves open. */
export const OPEN_ENUM_TYPE = 'OpenEnum';

/**
 * How a type name is written in the file being emitted.
 *
 * models.ts refers to a schema by its bare name and to a named value set as `Enums.X`; a resource
 * file refers to everything as `Models.X`, because 7 of the 42 endpoint-group classes share a name
 * with a schema — `ChannelPointSettings` is both a tag and a model — and a bare import would
 * collide with the class in the same file.
 */
export type Qualifier = (name: string) => string;

export class TypeMapper {
  /**
   * Nothing here needs the description itself: a `$ref` maps to the referenced type's *name*, and
   * TypeScript resolves the name. That is the whole reason this file is a fifth the length of its
   * counterpart in synchra-php, which has to resolve every reference to decide how to read it.
   */
  constructor(private readonly qualify: Qualifier = (name) => name) {}

  /**
   * The type expression for one schema fragment.
   *
   * `$ref`s are emitted as the referenced type's name rather than expanded, so a schema that
   * refers to itself terminates here without a recursion guard — the alias TypeScript emits for it
   * is legal because every self-reference in this description goes through an array or a map.
   */
  map(schema: unknown): string {
    if (!isObject(schema)) {
      return 'unknown';
    }

    const ref = schema.$ref;

    if (typeof ref === 'string') {
      return this.qualify(schemaType(refName(ref)));
    }

    const branches = schema.anyOf ?? schema.oneOf;

    if (isArray(branches)) {
      return this.union(branches);
    }

    if (isArray(schema.enum)) {
      return literalUnion(schema.enum);
    }

    if (schema.const !== undefined) {
      return literal(schema.const);
    }

    switch (schema.type) {
      case 'string':
        return schema.format === 'date-time' ? this.qualify(DATE_TIME_TYPE) : 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array':
        return this.array(schema);
      case 'object':
        return this.record(schema);
      default:
        return 'unknown';
    }
  }

  private array(schema: JsonObject): string {
    const items = this.map(schema.items);

    // `(A | B)[]` rather than `A | B[]`, which would mean something else entirely.
    return needsParentheses(items) ? `(${items})[]` : `${items}[]`;
  }

  private record(schema: JsonObject): string {
    const values = schema.additionalProperties;

    // `additionalProperties: false`, or a missing one, means a free-form object the description
    // does not characterise. `unknown` values are right there: a caller has to check before using
    // them.
    const value =
      values === undefined || values === false || !isObject(values) ? 'unknown' : this.map(values);

    // An inline index signature rather than `Record<string, T>`. Four schemas describe "any JSON
    // value" by referring to themselves through their own map branch, and `Record<string, T>` in a
    // union makes TypeScript call that alias circular, where an index signature is resolved lazily
    // and does not.
    return `{ [key: string]: ${value} }`;
  }

  private union(branches: unknown[]): string {
    const parts = new Set<string>();

    for (const branch of branches) {
      parts.add(this.map(branch));
    }

    return this.joinUnion([...parts]);
  }

  /**
   * Joins union members, folding "these literals, or any string" into {@link OpenEnum}.
   *
   * The description models an activity type as a union of every platform's enum *plus* a bare
   * `string`, because the service does send values that are in none of the enums. A plain union of
   * those absorbs every literal into `string` and leaves an editor with nothing to suggest, so the
   * known values would be lost from the type despite being right there in the description.
   */
  private joinUnion(parts: readonly string[]): string {
    // `unknown` absorbs everything it is unioned with, so `unknown | null` says exactly `unknown`
    // with more words. Two schemas describe a rejected value as "any JSON type, or null".
    if (parts.includes('unknown')) {
      return 'unknown';
    }

    // `IsoDateTime` *is* `string`, so a union of both says `string` twice. The description does
    // write that — a few fields accept either a timestamp or a free-form string — and the plain
    // string is the honest one to keep.
    const deduped = parts.includes('string')
      ? parts.filter((part) => !part.endsWith(DATE_TIME_TYPE))
      : parts;

    const literals = deduped.filter((part) => part.startsWith('"'));
    const rest = deduped.filter((part) => !part.startsWith('"'));

    if (literals.length === 0 || !rest.includes('string')) {
      return deduped.join(' | ');
    }

    const others = rest.filter((part) => part !== 'string');
    const open = `${this.qualify(OPEN_ENUM_TYPE)}<${literals.join(' | ')}>`;

    return [open, ...others].join(' | ');
  }
}

export function literal(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value === null) {
    return 'null';
  }

  return 'unknown';
}

export function literalUnion(values: readonly unknown[]): string {
  const parts = new Set(values.map(literal));

  return parts.size === 0 ? 'unknown' : [...parts].join(' | ');
}

/** Whether a type expression has to be parenthesised before `[]` or `|` is appended. */
export function needsParentheses(type: string): boolean {
  return type.includes('|') || type.includes('=>');
}
