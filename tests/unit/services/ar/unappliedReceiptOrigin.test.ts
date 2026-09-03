// RED phase — written before src/modules/accounting/services/ar/unappliedReceiptOrigin.ts exists.
/**
 * Who created the unapplied receipts.
 *
 * THE REASON THIS EXISTS. `allocateTransaction` with `allocType='customer'`
 * posts DR Bank / CR Accounts Receivable, inserts a CONFIRMED
 * `customer_payments` row, and writes no allocations and no `amount_paid`. So
 * the unapplied balance is not a historical residue that stopped growing — it
 * is DRIVEN UP by every allocation an agent makes, and a bulk run drives it up
 * hundreds of rows at a time. Re-derived against production on 2026-09-03:
 * R39,486,371.68 of the R42,759,565.12 unapplied system-wide carries an `mcp:`
 * stamp, and every one of those stamps is `bulk_allocate_bank_transactions`.
 *
 * "How much of this did the tooling make" is therefore the question that
 * follows immediately from the total, and a report that cannot answer it sends
 * the reader looking for a historical cause that is not there.
 *
 * What is pinned:
 *
 *  - A receipt with NO journal is its own bucket. It is not folded into the
 *    human bucket, because "we cannot tell" and "a person did it" are different
 *    facts and only one of them is true.
 *  - The `human` bucket is labelled **not stamped as an agent**, never "human".
 *    `createJournalEntry` falls back to `defaultHumanMeta(userId)` whenever a
 *    caller omits the meta, so an unknown number of agent postings sit in it —
 *    `resolveLegacyActorType` documents the asymmetry and this must not
 *    contradict it.
 *  - The join to `gl_journal_entries` is an OUTER join whose ON clause carries
 *    only join keys. A predicate that must RESTRICT belongs in WHERE: in an
 *    outer join's ON it restricts nothing, the unmatched row survives carrying
 *    NULLs, and those NULLs then flow into the arithmetic.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getUnappliedReceiptOrigins } from '@/modules/accounting/services/ar/unappliedReceiptOrigin';

const COMPANY = '11111111-1111-4111-8111-111111111111';
type Row = Record<string, unknown>;
const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<Row[]>>;

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getUnappliedReceiptOrigins', () => {
  it('splits the unapplied total by who created it, agent stamps named', async () => {
    sqlMock.mockResolvedValueOnce([
      { posting_agent: 'mcp:bulk_allocate_bank_transactions:v1', receipts: 34, unapplied: '2436024.00' },
      { posting_agent: 'system:bank-allocation:v1', receipts: 2, unapplied: '245000.00' },
      { posting_agent: 'legacy:auto_payment', receipts: 1, unapplied: '10000.00' },
      { posting_agent: null, receipts: 3, unapplied: '5000.00' },
    ]);

    const out = await getUnappliedReceiptOrigins(COMPANY, '2026-09-03');

    expect(out.agent).toEqual({ receipts: 34, unapplied: 2436024 });
    expect(out.system).toEqual({ receipts: 2, unapplied: 245000 });
    expect(out.notStampedAsAgent).toEqual({ receipts: 1, unapplied: 10000 });
    // A receipt with no journal is NOT a human receipt — it is an unknown one.
    expect(out.noJournal).toEqual({ receipts: 3, unapplied: 5000 });
    expect(out.agentTools).toEqual([
      { postingAgent: 'mcp:bulk_allocate_bank_transactions:v1', receipts: 34, unapplied: 2436024 },
    ]);
  });

  it('THE ARITHMETIC ACCOUNTS FOR EVERY RECEIPT — the four buckets sum to the whole', async () => {
    sqlMock.mockResolvedValueOnce([
      { posting_agent: 'mcp:x:v1', receipts: 5, unapplied: '100.00' },
      { posting_agent: 'system:y', receipts: 2, unapplied: '50.00' },
      { posting_agent: 'human:abc', receipts: 3, unapplied: '25.00' },
      { posting_agent: null, receipts: 1, unapplied: '5.00' },
    ]);
    const out = await getUnappliedReceiptOrigins(COMPANY, '2026-09-03');
    const receipts = out.agent.receipts + out.system.receipts
      + out.notStampedAsAgent.receipts + out.noJournal.receipts;
    const unapplied = out.agent.unapplied + out.system.unapplied
      + out.notStampedAsAgent.unapplied + out.noJournal.unapplied;
    expect(receipts).toBe(11);
    expect(unapplied).toBe(180);
    expect(out.total).toEqual({ receipts: 11, unapplied: 180 });
  });

  it('LABELS THE HUMAN BUCKET AS UNPROVEN, matching resolveLegacyActorType', async () => {
    sqlMock.mockResolvedValueOnce([{ posting_agent: 'human:abc', receipts: 1, unapplied: '1.00' }]);
    const out = await getUnappliedReceiptOrigins(COMPANY, '2026-09-03');
    // "not stamped as an agent", never "typed by a person".
    expect(out.caveat).toMatch(/not stamped as an agent/i);
    expect(out.caveat).not.toMatch(/proven human|typed by a person/i);
  });

  it('returns zeroed buckets rather than throwing when nothing is unapplied', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const out = await getUnappliedReceiptOrigins(COMPANY, '2026-09-03');
    expect(out.total).toEqual({ receipts: 0, unapplied: 0 });
    expect(out.agentTools).toEqual([]);
  });

  it('USES AN OUTER JOIN WHOSE ON CLAUSE CARRIES ONLY JOIN KEYS', async () => {
    // A predicate that must restrict the result belongs in WHERE. In the ON
    // clause of an outer join it restricts nothing: the unmatched row survives
    // with NULL columns and is summed anyway. kpiChartsService did exactly this
    // with `is_active = true AND account_subtype = 'bank'` and charted every
    // transaction regardless of account.
    sqlMock.mockResolvedValueOnce([]);
    await getUnappliedReceiptOrigins(COMPANY, '2026-09-03');
    const text = (sqlMock.mock.calls[0]![0] as string[]).join('?');
    const onClause = text.slice(text.indexOf('LEFT JOIN gl_journal_entries'));
    const joinCondition = onClause.slice(0, onClause.indexOf('LEFT JOIN LATERAL'));
    // Only equi-join keys between the two tables — no status, no date, no flag.
    expect(joinCondition).not.toMatch(/je\.status/);
    expect(joinCondition).not.toMatch(/is_active/);
    expect(joinCondition).toMatch(/je\.id\s*=\s*cp\.gl_journal_entry_id/);
    expect(joinCondition).toMatch(/je\.company_id\s*=\s*cp\.company_id/);
  });

  it('scopes to the company and to the as-at date', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await getUnappliedReceiptOrigins(COMPANY, '2026-09-03');
    const values = sqlMock.mock.calls[0]!.slice(1);
    expect(values).toContain(COMPANY);
    expect(values).toContain('2026-09-03');
  });

  it('excludes cancelled receipts, matching the listing it accompanies', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await getUnappliedReceiptOrigins(COMPANY, '2026-09-03');
    const text = (sqlMock.mock.calls[0]![0] as string[]).join('?');
    expect(text).toMatch(/cp\.status <> 'cancelled'/);
  });
});
