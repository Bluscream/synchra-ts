/**
 * Turns names from the API description into TypeScript identifiers.
 *
 * Everything here is deterministic: the same description always produces the same identifiers, so
 * regenerating after an unrelated API change does not churn the whole tree.
 *
 * The overrides mirror synchra-php's, deliberately — the two clients name the same endpoint the
 * same way, so a caveat written against one reads correctly against the other.
 */

/**
 * Schema names the description spells awkwardly, or that FastAPI derived from a Python type
 * annotation and so carry the whole annotation in the name.
 */
const SCHEMA_OVERRIDES: Readonly<Record<string, string>> = {
  UserProfiles_Annotated_Union_DashboardUserProfile__ChatUserProfile__ActivityFeedUserProfile__ControlsUserProfile___FieldInfo_annotation_NoneType__required_True__discriminator__type____:
    'UserProfileList',

  // `Error` would shadow the global `Error` in every module that imports it, and exporting a type
  // called `Error` from the package barrel would do it in the caller's module too. synchra-php
  // keeps the API's name because a PHP namespace separates them; here the name has to change.
  Error: 'ErrorBody',
};

/** Tags whose class name needs the API's own capitalisation rather than title case. */
const TAG_OVERRIDES: Readonly<Record<string, string>> = {
  ElevenLabs: 'ElevenLabs',
  StreamElements: 'StreamElements',
  TTSMonster: 'TtsMonster',
  WebSocket: 'Gateway',
  YouTube: 'YouTube',
  'OBS Remote': 'ObsRemote',
  'Ko-fi': 'KoFi',
  'Admin HTTP Proxies': 'AdminHttpProxies',
};

/**
 * Operations whose summary is not unique inside its tag, or is actively misleading — the Twitch and
 * YouTube moderator endpoints are all summarised "Ban User".
 *
 * Keyed by `METHOD path`.
 */
const METHOD_OVERRIDES: Readonly<Record<string, string>> = {
  'POST /api/2/channels/{channel_id}/twitch/{channel_provider_id}/moderators': 'addModerator',
  'DELETE /api/2/channels/{channel_id}/twitch/{channel_provider_id}/moderators': 'removeModerator',
  'POST /api/2/channels/{channel_id}/youtube/{channel_provider_id}/moderators': 'addModerator',
  'DELETE /api/2/channels/{channel_id}/youtube/{channel_provider_id}/moderators': 'removeModerator',
  'PUT /api/2/channels/{channel_id}/providers/{channel_provider_id}/stream': 'updateStream',
};

/** Identifiers that are reserved words or would shadow something in a generated file. */
const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'await',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
]);

export function pascal(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  let out = '';

  for (const word of words) {
    // Keep inner capitals that are already meaningful (HTTP, TTS, OBS) instead of lowercasing them
    // into Http, Tts, Obs.
    out += /^[A-Z0-9]+$/.test(word)
      ? word.charAt(0) + word.slice(1).toLowerCase()
      : word.charAt(0).toUpperCase() + word.slice(1);
  }

  if (out === '') {
    return 'Unnamed';
  }

  return /^[0-9]/.test(out) ? `N${out}` : out;
}

export function camel(value: string): string {
  const name = pascal(value);
  const lowered = name.charAt(0).toLowerCase() + name.slice(1);

  return RESERVED.has(lowered) ? `${lowered}_` : lowered;
}

export function schemaType(name: string): string {
  return pascal(SCHEMA_OVERRIDES[name] ?? name);
}

export function tagClass(tag: string): string {
  return TAG_OVERRIDES[tag] ?? pascal(tag);
}

export function operationMethod(httpMethod: string, path: string, summary: string): string {
  const override = METHOD_OVERRIDES[`${httpMethod.toUpperCase()} ${path}`];

  if (override !== undefined) {
    return override;
  }

  // Summaries generated from FastAPI route function names keep a "Route" suffix that says nothing
  // about the operation.
  return camel(summary.replace(/\s+Route$/i, ''));
}

/**
 * Whether a wire name can be written as a bare property in an interface, or has to be quoted.
 *
 * The API is snake_case throughout, which is already valid, but a few header parameters carry
 * hyphens (`x-kv-token`) and those have to be quoted.
 */
export function propertyKey(wire: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(wire) ? wire : JSON.stringify(wire);
}

/** How to read a property off an object: `params.channel_id`, or `params["x-kv-token"]`. */
export function propertyAccess(object: string, wire: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(wire)
    ? `${object}.${wire}`
    : `${object}[${JSON.stringify(wire)}]`;
}
