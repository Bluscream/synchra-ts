import { describe, expect, it, vi } from 'vitest';

import { SynchraError } from '../src/errors.js';
import { collect, paginate, type CursorPage } from '../src/pagination.js';

/** Pages a list the way the API does: `records` plus the cursor for the next page. */
function pager(pages: readonly (readonly number[])[]): {
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<number>>;
  cursors: (string | undefined)[];
} {
  const cursors: (string | undefined)[] = [];

  return {
    cursors,
    fetchPage: (cursor) => {
      cursors.push(cursor);

      const index = cursor === undefined ? 0 : Number(cursor);
      const records = pages[index] ?? [];
      const hasMore = index + 1 < pages.length;

      return Promise.resolve({
        records,
        cursor: hasMore ? String(index + 1) : null,
        total: pages.flat().length,
      });
    },
  };
}

describe('paginate', () => {
  it('walks every page and asks for the first one with no cursor', async () => {
    const { fetchPage, cursors } = pager([[1, 2], [3, 4], [5]]);

    await expect(collect(fetchPage)).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(cursors).toEqual([undefined, '1', '2']);
  });

  it('stops on a page that carries no cursor', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ records: [1], cursor: null });

    await expect(collect(fetchPage)).resolves.toEqual([1]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('treats an empty cursor as the end', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ records: [1], cursor: '' });

    await expect(collect(fetchPage)).resolves.toEqual([1]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('refuses to loop on a cursor the API repeats', async () => {
    // Not hypothetical: a filter whose results change between requests can produce a cursor
    // pointing at a page already returned, and the failure mode without this is a process that
    // fetches the same page until it is killed.
    const fetchPage = vi.fn().mockResolvedValue({ records: [1], cursor: 'same' });

    await expect(collect(fetchPage)).rejects.toBeInstanceOf(SynchraError);
    await expect(collect(fetchPage)).rejects.toThrow(/returned the cursor "same" twice/);
  });

  it('stops after maxPages', async () => {
    const { fetchPage, cursors } = pager([[1], [2], [3], [4]]);

    await expect(collect(fetchPage, { maxPages: 2 })).resolves.toEqual([1, 2]);
    expect(cursors).toHaveLength(2);
  });

  it('stops after maxRecords, mid-page', async () => {
    const { fetchPage, cursors } = pager([
      [1, 2, 3],
      [4, 5, 6],
    ]);

    await expect(collect(fetchPage, { maxRecords: 2 })).resolves.toEqual([1, 2]);
    expect(cursors).toHaveLength(1);
  });

  it('is lazy: the next page is not fetched until the consumer asks', async () => {
    const { fetchPage, cursors } = pager([
      [1, 2],
      [3, 4],
    ]);

    const iterator = paginate(fetchPage);

    await iterator.next();

    expect(cursors).toEqual([undefined]);

    await iterator.return();
  });

  it('yields nothing for an empty first page', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ records: [], cursor: null });

    await expect(collect(fetchPage)).resolves.toEqual([]);
  });
});
