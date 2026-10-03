/**
 * A ROUND NUMBER IS AN ESTIMATE ONLY WHERE SOMEONE TYPED IT.
 *
 * The round-number rule exists because a hand-entered R50 000 tends to be an
 * estimate standing in for an actual. Velocity Fibre's board pack raised 880
 * matters off it, and on the production copy 688 of its 693 round-number
 * flags were postings generated from documents — a customer invoice, a
 * supplier payment, a bank allocation — whose round amount is the document's.
 * Those are not tested for a round number any more; every other source,
 * including an unknown or missing one, still is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlSpy }));

import { getUnusualJournals } from '@/modules/accounting/services/reports/unusualJournalsService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const WINDOW = { start: '2026-01-01', end: '2026-10-02' };

const row = (id: string, source: string | null, over: Record<string, unknown> = {}) => ({
  id, entry_number: `JE-${id}`, entry_date: '2026-03-10', description: 'x', source,
  created_at: new Date('2026-03-10T08:00:00.000Z'), amount: 6_000_000, ...over,
});

async function reasons(...rows: ReturnType<typeof row>[]) {
  sqlSpy.mockResolvedValue(rows);
  return (await getUnusualJournals(COMPANY, WINDOW)).flags.map((f) => [f.entryId, f.reason]);
}

beforeEach(() => sqlSpy.mockReset());

describe('the round-number test', () => {
  it('does not flag a posting generated from a document', async () => {
    expect(await reasons(
      row('inv', 'auto_invoice'), row('pay', 'auto_supplier_payment'), row('bank', 'auto_bank_recon'),
    )).toEqual([]);
  });

  it('flags a hand-entered journal, and one whose source is unknown or missing', async () => {
    expect(await reasons(row('m', 'manual'), row('s', 'sage_import'), row('n', null))).toEqual([
      ['m', 'round_number'], ['s', 'round_number'], ['n', 'round_number'],
    ]);
  });

  it('still tests a document posting for late recording', async () => {
    const late = row('late', 'auto_supplier_invoice', { created_at: new Date('2026-04-20T08:00:00.000Z') });
    expect(await reasons(late)).toEqual([['late', 'backdated']]);
  });
});

// NOT PINNED HERE: that the SELECT returns `je.source`. A mocked `sql` hands
// back whatever row it is given, so dropping the column from the query would
// leave this file green while production flagged every source alike. The
// read-only run against the production copy is the evidence for the query.
