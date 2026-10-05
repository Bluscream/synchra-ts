/**
 * Cursor pagination, as an async iterable.
 *
 * The generated methods return the page exactly as the API sends it — `{ records, cursor, total }` —
 * rather than wrapping it, because the wrapper would have to be generated for each of the paged
 * endpoints and would hide `total` and `lookup_data`. Walking every page is this one helper instead:
 *
 * ```ts
 * for await (const activity of paginate((cursor) =>
 *   synchra.activity.getActivities({ channel_id, cursor, per_page: 100 }),
 * )) {
 *   console.log(activity.type_display_name);
 * }
 * ```
 */
import { SynchraError } from './errors.js';

/** The shape every `PageCursor_X_` in the description has. */
export interface CursorPage<T> {
  readonly records: readonly T[];
  readonly cursor?: string | null | undefined;
  readonly total?: number | null | undefined;
}

export interface PaginateOptions {
  /**
   * Stop after this many pages.
   *
   * Unset means "until the API stops sending a cursor". Worth setting when walking a busy channel's
   * chat history, which is effectively unbounded.
   */
  readonly maxPages?: number;

  /** Stop after this many records. The last page is still fetched whole. */
  readonly maxRecords?: number;
}

/**
 * Walks every record across every page.
 *
 * `fetchPage` receives the cursor for the page to fetch, `undefined` for the first.
 *
 * A cursor the API repeats stops the walk with an error rather than looping forever. That is not a
 * hypothetical: a filter whose results change between requests can produce a cursor that points at
 * a page it already returned, and the failure mode without this check is a process that fetches the
 * same page until it is killed.
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let records = 0;

  for (;;) {
    const page = await fetchPage(cursor);

    pages += 1;

    for (const record of page.records) {
      yield record;

      records += 1;

      if (options.maxRecords !== undefined && records >= options.maxRecords) {
        return;
      }
    }

    const next = page.cursor;

    if (next === undefined || next === null || next === '') {
      return;
    }

    if (seen.has(next)) {
      throw new SynchraError(
        `Pagination stopped: the API returned the cursor "${next}" twice, which would loop forever.`,
      );
    }

    seen.add(next);
    cursor = next;

    if (options.maxPages !== undefined && pages >= options.maxPages) {
      return;
    }
  }
}

/** Every record across every page, collected into one array. */
export async function collect<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
  options: PaginateOptions = {},
): Promise<T[]> {
  const out: T[] = [];

  for await (const record of paginate(fetchPage, options)) {
    out.push(record);
  }

  return out;
}
