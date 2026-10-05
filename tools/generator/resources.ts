/**
 * Emits one class per tag of the description, each method one endpoint.
 *
 * Every method takes a single options object rather than positional arguments. That is not only
 * ergonomics: it is what makes this generator insensitive to the description's key order. A
 * positional signature has to pick an order for its parameters, and the only order available is the
 * description's own — which the API does not promise, and which moved 290 of synchra-php's
 * constructors the one time it was normalised.
 *
 * Parameter names stay the API's `snake_case`, so a value read off a model goes straight into a
 * call: `channels.getChannel({ channel_id: channel.id })`.
 */
import { docComment, type Emitter } from './emitter.js';
import { camel, operationMethod, pascal, propertyAccess, propertyKey, tagClass } from './names.js';
import {
  isObject,
  relativePath,
  stringAt,
  requestBodyRequired,
  requestBodySchema,
  successSchema,
  type JsonObject,
  type Operation,
  type Spec,
} from './spec.js';
import { literal, type TypeMapper } from './types.js';

/** The content type the upload endpoints declare as a header constant. */
const RAW_BODY_CONTENT_TYPE = 'application/octet-stream';

/**
 * Longest description to inline into a doc comment, in characters.
 *
 * Generous for a note — the longest annotation is well under a kilobyte — and far below the one
 * description the service actually fills, which is the entire 62 KB WebSocket reference.
 */
const MAX_DESCRIPTION = 4096;

interface Group {
  readonly className: string;
  readonly module: string;
  /** The names of the per-operation options interfaces this module exports. */
  readonly params: readonly string[];
}

export interface ResourcesResult {
  readonly groups: ReadonlyMap<string, Group>;
  readonly operations: number;
}

export async function emitResources(
  emitter: Emitter,
  spec: Spec,
  types: TypeMapper,
): Promise<ResourcesResult> {
  const byTag = new Map<string, Operation[]>();

  for (const operation of spec.operations) {
    const existing = byTag.get(operation.tag);

    if (existing === undefined) {
      byTag.set(operation.tag, [operation]);
    } else {
      existing.push(operation);
    }
  }

  const groups = new Map<string, Group>();
  const tags = [...byTag.keys()].sort((a, b) => a.localeCompare(b));

  for (const tag of tags) {
    const className = tagClass(tag);
    const module = kebab(className);
    const operations = byTag.get(tag) ?? [];
    const rendered = renderResource(tag, className, operations, types);

    groups.set(tag, { className, module, params: rendered.params });

    await emitter.write(`src/generated/resources/${module}.ts`, rendered.source);
  }

  await emitter.write('src/generated/resources/index.ts', renderIndex(groups));
  await emitter.write('src/generated/resources/params.ts', renderParamsIndex(groups));

  return { groups, operations: spec.operations.length };
}

function renderResource(
  tag: string,
  className: string,
  operations: readonly Operation[],
  types: TypeMapper,
): { source: string; params: string[] } {
  const used = new Set<string>();
  const paramInterfaces: string[] = [];
  const paramNames: string[] = [];
  const methods: string[] = [];

  for (const operation of operations) {
    const method = describeMethod(operation, className, used, types);

    used.add(method.name);
    paramInterfaces.push(method.paramsInterface);
    paramNames.push(method.paramsName);
    methods.push(method.body);
  }

  const rendered = `${paramInterfaces.join('\n')}\n${methods.join('\n')}`;
  const doc = docComment([
    `The \`${tag}\` endpoints.`,
    '',
    `Reach this group with \`synchra.${camel(className)}\`.`,
  ]);

  const imports = [
    "import type { ApiClient } from '../../client.js';",
    rendered.includes('expandPath(')
      ? "import { expandPath, type RequestOptions } from '../../wire.js';"
      : "import type { RequestOptions } from '../../wire.js';",
    // A namespace import, because 7 of the 42 group classes share a name with a schema and a bare
    // named import would collide with the class declared in the same file.
    rendered.includes('Models.') ? "import type * as Models from '../models.js';" : '',
  ].filter((line) => line !== '');

  const source = [
    docComment([`The \`${tag}\` endpoints, and the options each one takes.`]),
    imports.join('\n'),
    paramInterfaces.join('\n'),
    `${doc}export class ${className} {\n  constructor(private readonly client: ApiClient) {}\n\n${methods.join('\n')}}\n`,
  ]
    .filter((part) => part !== '')
    .join('\n\n');

  return { source, params: paramNames.sort((a, b) => a.localeCompare(b)) };
}

interface DescribedMethod {
  readonly name: string;
  readonly paramsName: string;
  readonly paramsInterface: string;
  readonly body: string;
}

function describeMethod(
  operation: Operation,
  className: string,
  used: ReadonlySet<string>,
  types: TypeMapper,
): DescribedMethod {
  const name = uniqueName(
    operationMethod(
      operation.method,
      operation.path,
      operation.summary !== '' ? operation.summary : operation.operationId,
    ),
    used,
  );

  const fields = collectFields(operation, types);
  const paramsName = `${className}${pascal(name)}Params`;
  const allOptional = fields.every((field) => field.optional);
  const returnType = responseType(operation, types);

  const argument = allOptional ? `params: ${paramsName} = {}` : `params: ${paramsName}`;
  const doc = docComment(methodDoc(operation, fields), '  ');

  return {
    name,
    paramsName,
    paramsInterface: renderParams(paramsName, operation, fields),
    body:
      `${doc}  ${name}(${argument}): Promise<${returnType}> {\n` +
      `    return this.client.${returnType === 'void' ? 'send' : `request<${returnType}>`}({\n` +
      `${requestLines(operation, fields)}\n    });\n  }\n`,
  };
}

/** One value a caller passes, and where it goes on the wire. */
interface Field {
  /** The property name in the options interface, which is the wire name. */
  readonly key: string;
  readonly type: string;
  readonly optional: boolean;
  readonly location: 'path' | 'query' | 'header' | 'body' | 'rawBody';
  /** The wire name, where it differs from a valid identifier (`x-kv-token`). */
  readonly wire: string;
  readonly doc: readonly string[];
}

function collectFields(operation: Operation, types: TypeMapper): Field[] {
  const fields: Field[] = [];

  for (const parameter of operation.pathParameters) {
    const wire = stringAt(parameter, 'name') ?? '';

    // Three webhook ingest routes declare a path parameter as `string | None`, an artefact of the
    // handler's annotation: a URL segment always carries a value, and there is no request a null
    // could produce. Path parameters are therefore never optional here, whatever the schema says.
    fields.push({
      key: wire,
      type: 'string | number',
      optional: false,
      location: 'path',
      wire,
      doc: parameterDoc(parameter),
    });
  }

  for (const parameter of operation.queryParameters) {
    const wire = stringAt(parameter, 'name') ?? '';
    const required = parameter.required === true;
    const mapped = types.map(parameter.schema);

    fields.push({
      key: wire,
      type: required ? mapped : `${mapped} | undefined`,
      optional: !required,
      location: 'query',
      wire,
      doc: parameterDoc(parameter),
    });
  }

  for (const parameter of operation.headerParameters) {
    const wire = stringAt(parameter, 'name') ?? '';
    const lower = wire.toLowerCase();

    // The upload endpoints declare their content type as a header constant; the raw body below
    // carries that meaning, so the header is set for the caller rather than asked for.
    if (lower === 'content-type' || lower === 'content-length') {
      continue;
    }

    const required = parameter.required === true;
    const mapped = types.map(parameter.schema);

    fields.push({
      key: wire,
      type: required ? mapped : `${mapped} | undefined`,
      optional: !required,
      location: 'header',
      wire,
      doc: parameterDoc(parameter),
    });
  }

  const body = bodyField(operation, types);

  if (body !== undefined) {
    fields.push(body);
  }

  return fields;
}

function bodyField(operation: Operation, types: TypeMapper): Field | undefined {
  if (expectsRawBody(operation)) {
    return {
      key: 'body',
      type: 'BodyInit',
      optional: false,
      location: 'rawBody',
      wire: 'body',
      doc: ['The raw bytes to upload.'],
    };
  }

  const schema = requestBodySchema(operation);

  if (schema === undefined) {
    return undefined;
  }

  const required = requestBodyRequired(operation);
  const mapped = types.map(schema);

  return {
    key: 'body',
    type: required ? mapped : `${mapped} | undefined`,
    optional: !required,
    location: 'body',
    wire: 'body',
    doc: ['The request body.'],
  };
}

function expectsRawBody(operation: Operation): boolean {
  return operation.headerParameters.some(
    (parameter) => isObject(parameter.schema) && parameter.schema.const === RAW_BODY_CONTENT_TYPE,
  );
}

function renderParams(name: string, operation: Operation, fields: readonly Field[]): string {
  const ordered = [...fields].sort((a, b) => {
    const byOptional = Number(a.optional) - Number(b.optional);

    return byOptional !== 0 ? byOptional : a.key.localeCompare(b.key);
  });

  const lines = ordered.map((field) => {
    const doc = docComment(field.doc, '  ');

    return `${doc}  ${propertyKey(field.key)}${field.optional ? '?' : ''}: ${field.type};`;
  });

  const doc = docComment([
    `Options for \`${operation.method} ${operation.path}\`.`,
    '',
    'Extends {@link RequestOptions}, so `signal`, `headers` and `retry` can be set per call.',
  ]);

  // An alias rather than an empty interface for the operations that take nothing: an interface
  // declaring no members is just its supertype under a second name.
  if (lines.length === 0) {
    return `${doc}export type ${name} = RequestOptions;\n`;
  }

  return `${doc}export interface ${name} extends RequestOptions {\n${lines.join('\n')}\n}\n`;
}

function requestLines(operation: Operation, fields: readonly Field[]): string {
  const lines = [
    `      method: ${literal(operation.method)},`,
    `      path: ${pathExpression(operation, fields)},`,
  ];

  const query = fields.filter((field) => field.location === 'query');

  if (query.length > 0) {
    const entries = query.map(
      (field) => `${propertyKey(field.wire)}: ${propertyAccess('params', field.key)}`,
    );

    lines.push(`      query: { ${entries.join(', ')} },`);
  }

  const headers = fields.filter((field) => field.location === 'header');

  if (headers.length > 0) {
    const entries = headers.map(
      (field) => `${propertyKey(field.wire)}: ${propertyAccess('params', field.key)}`,
    );

    lines.push(`      headers: { ${entries.join(', ')} },`);
  }

  const body = fields.find((field) => field.location === 'body');

  if (body !== undefined) {
    lines.push('      body: params.body,');
  }

  const rawBody = fields.find((field) => field.location === 'rawBody');

  if (rawBody !== undefined) {
    lines.push('      rawBody: params.body,');
    lines.push(`      contentType: ${literal(RAW_BODY_CONTENT_TYPE)},`);
  }

  // Passed through last so a per-call `headers` merges over the ones the operation declares, and so
  // `signal` and `retry` reach the client without each method naming them.
  lines.push('      options: params,');

  return lines.join('\n');
}

function pathExpression(operation: Operation, fields: readonly Field[]): string {
  const template = relativePath(operation.path);
  const pathFields = fields.filter((field) => field.location === 'path');

  if (pathFields.length === 0) {
    return literal(template);
  }

  const entries = pathFields.map(
    (field) => `${propertyKey(field.wire)}: ${propertyAccess('params', field.key)}`,
  );

  return `expandPath(${literal(template)}, { ${entries.join(', ')} })`;
}

function responseType(operation: Operation, types: TypeMapper): string {
  const schema = successSchema(operation);

  // No schema means an empty body — 58 operations answer `204`.
  return schema === undefined ? 'void' : types.map(schema);
}

function methodDoc(operation: Operation, fields: readonly Field[]): string[] {
  const lines: string[] = [];

  if (operation.summary !== '') {
    lines.push(`${operation.summary.replace(/\.$/, '')}.`, '');
  }

  lines.push(`\`${operation.method} ${operation.path}\``);

  if (operation.isPublic) {
    lines.push('', 'Needs no credential; this one answers on an anonymous client.');
  } else if (operation.scopes.length > 0) {
    lines.push('', `Requires the \`${operation.scopes.join('`, `')}\` scope.`);
  }

  // After the scope line on purpose: where both are present the note is usually qualifying the
  // scope — "holding this one is necessary and not sufficient".
  //
  // Length-capped because one operation's description is not a note at all: `GET /api/2/ws-docs`
  // answers with the whole WebSocket reference, and the service puts that same 62 KB in its
  // description. Anything that long is a document, and a doc comment should point at it.
  if (operation.description !== '') {
    lines.push('');

    if (operation.description.length > MAX_DESCRIPTION) {
      lines.push(
        `The response is a ${String(Math.round(operation.description.length / 1024))} KB Markdown`,
        'document; the vendored copy is in `spec/websocket.md`.',
      );
    } else {
      lines.push(...operation.description.split('\n').map((line) => line.trimEnd()));
    }
  }

  const documented = fields.filter((field) => field.doc.length > 0);

  if (documented.length > 0) {
    lines.push('');

    for (const field of documented) {
      lines.push(`@param params.${field.key} ${field.doc.join(' ')}`);
    }
  }

  return lines;
}

function parameterDoc(parameter: JsonObject): string[] {
  const description = parameter.description;

  if (typeof description !== 'string' || description.trim() === '') {
    return [];
  }

  return [`${description.trim().replace(/\.$/, '')}.`];
}

function renderIndex(groups: ReadonlyMap<string, Group>): string {
  const lines: string[] = [];
  const accessors: string[] = [];
  const imports: string[] = [];
  const assignments: string[] = [];

  for (const [tag, { className, module }] of groups) {
    lines.push(`export { ${className} } from './${module}.js';`);
    accessors.push(`  readonly ${camel(className)}: ${className};`);
    imports.push(`import { ${className} } from './${module}.js';`);
    assignments.push(
      `${docComment([`The \`${tag}\` endpoints.`], '    ')}    this.${camel(className)} = new ${className}(client);`,
    );
  }

  const doc = docComment([
    'Every endpoint group, hung off one object.',
    '',
    'Each group is constructed once, when the client is: there are 42 of them, they hold no state',
    'beyond the client they share, and a lazy accessor for each would be more machinery than the',
    'allocation it saves.',
  ]);

  return [
    docComment(['Every endpoint group of the API description.']),
    "import type { ApiClient } from '../../client.js';",
    imports.join('\n'),
    lines.join('\n'),
    `${doc}export class Resources {\n${accessors.join('\n')}\n\n  constructor(client: ApiClient) {\n${assignments.join('\n')}\n  }\n}\n`,
  ].join('\n\n');
}

/**
 * A barrel of just the per-operation options interfaces.
 *
 * Separate from the classes because six group names collide with a schema of the same name —
 * `Channel`, `User`, `ChannelStream` and three more are both a tag and a model — so the package's
 * own barrel cannot re-export both flat. The models win the flat namespace, since they are what a
 * caller handles constantly; the classes are reachable as `groups.Channel`, and these options
 * interfaces never collide because each is prefixed with its group's name.
 */
function renderParamsIndex(groups: ReadonlyMap<string, Group>): string {
  const lines = [...groups.values()]
    .filter((group) => group.params.length > 0)
    .map((group) => `export type { ${group.params.join(', ')} } from './${group.module}.js';`);

  return [
    docComment([
      'The options interface for every operation.',
      '',
      'One per endpoint, named after its group and method — `ChannelActivityGetActivitiesParams`.',
    ]),
    lines.join('\n'),
  ].join('\n\n');
}

function uniqueName(name: string, used: ReadonlySet<string>): string {
  if (!used.has(name)) {
    return name;
  }

  for (let suffix = 2; ; suffix += 1) {
    const next = `${name}${String(suffix)}`;

    if (!used.has(next)) {
      return next;
    }
  }
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}
