/**
 * The drill's document lookup is BATCHED (PR-B review r1 H1, pinned in r2 N4): one statement per
 * document table, whatever the number of journal ids, each passing the whole id list and the company.
 * A per-id lookup (the 1.1 s LATERAL, or a loop of reads) multiplies the statements by the rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as unknown[]));
vi.mock('@/lib/neon', () => ({ sql }));

import { DOCUMENT_PRIORITY, loadJournalDocuments } from '@/modules/accounting/services/gl/journalDocuments';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

beforeEach(() => { sql.mockClear(); });

describe('loadJournalDocuments batching', () => {
  it.each([[1], [7], [500]])('%i journal ids: one statement per document table', async (n) => {
    await loadJournalDocuments('co-1', ids(n));
    expect(sql).toHaveBeenCalledTimes(DOCUMENT_PRIORITY.length);
    for (const call of sql.mock.calls) {
      const values = call.slice(1);
      expect(values).toContain('co-1');
      expect(values).toContainEqual(ids(n));
    }
  });

  it('repeated ids are read once, and no ids is no statement', async () => {
    await loadJournalDocuments('co-1', [...ids(3), ...ids(3)]);
    for (const call of sql.mock.calls) expect(call.slice(1)).toContainEqual(ids(3));
    sql.mockClear();
    await loadJournalDocuments('co-1', []);
    expect(sql).not.toHaveBeenCalled();
  });
});
