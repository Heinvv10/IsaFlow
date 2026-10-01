/**
 * The VAT-lock reclassification decision, with no database: which account
 * changes would move a filed VAT figure. Runs in `env -u DATABASE_URL vitest`,
 * so CI sees it. The real-ledger behaviour is pinned in
 * tests/integration/vat-period-lock-reclass.int.test.ts.
 *
 *   - lineReclassifies: the snapshot's own classifier, before vs after.
 *   - decideLockedReclass: refuses when a journal's MEMBERSHIP flips, or a
 *     changing account's line in a folded-in journal changes class.
 *   - findLockedReclassification: ONE query for all changes together,
 *     tenant-scoped, ACTIVE locks and POSTED journals only, DISTINCT-bounded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ calls: [] as { text: string; values: unknown[] }[], rows: [] as unknown[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn((strings: readonly string[], ...values: unknown[]) => {
    const text = strings.join('?');
    h.calls.push({ text, values });
    return Promise.resolve(/FROM gl_journal_lines l/.test(text) ? h.rows : []);
  }),
}));

import {
  assertAccountChangesKeepVatLocks, decideLockedReclass, findLockedReclassification, lineReclassifies,
  type LockedJournalShape,
} from '@/modules/accounting/services/gl/vatLockLineClassification';

const CO = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const EXPENSE = { accountType: 'expense', accountSubtype: 'operating_expense' };
const EXPENSE2 = { accountType: 'expense', accountSubtype: 'admin_expense' };
const VAT_IN = { accountType: 'asset', accountSubtype: 'vat_input' };
const ASSET_NULL = { accountType: 'asset', accountSubtype: null };
const BANK = { accountType: 'asset', accountSubtype: 'bank' };
const FIXED = { accountType: 'asset', accountSubtype: 'fixed_asset' };
const OTHER = { accountType: 'asset', accountSubtype: 'other' };

const change = (from: typeof EXPENSE | typeof VAT_IN | typeof ASSET_NULL, to: typeof EXPENSE | typeof VAT_IN | typeof ASSET_NULL,
  accountId = ACC) => ({ accountId, accountCode: '1300', from, to });

const row = (over: Partial<LockedJournalShape> = {}): LockedJournalShape => ({
  lockId: 'lock-1', periodStart: '2026-05-01', periodEnd: '2026-06-30',
  memberBefore: false, memberAfter: false, accountId: ACC, vatType: null, sign: 1, ...over,
});

beforeEach(() => { h.calls.length = 0; h.rows = []; });

describe('lineReclassifies (the snapshot classifier, before vs after)', () => {
  it.each([
    ['untagged, expense → expense', null, EXPENSE, EXPENSE2, false],
    ['a VAT input leg → an ordinary asset', null, VAT_IN, OTHER, true],
    ['tagged capital goods, fixed asset → other asset (base → unmapped)', 'capital_goods', FIXED, OTHER, true],
    ['untagged, asset NULL → bank (base → settlement)', null, ASSET_NULL, BANK, true],
    ['tagged receivable → expense-typed receivable (settlement either way)', 'zero_rated',
      { accountType: 'asset', accountSubtype: 'receivable' }, { accountType: 'expense', accountSubtype: 'receivable' }, false],
    ['same attributes', 'standard', VAT_IN, VAT_IN, false],
  ] as const)('%s', (_n, vatType, from, to, expected) => {
    expect(lineReclassifies({ vatType, debit: 40, credit: 0 }, from, to)).toBe(expected);
  });
});

describe('decideLockedReclass', () => {
  it('ignores a journal folded in neither before nor after (paycard NULL → bank, untagged salary)', () => {
    expect(decideLockedReclass([row()], [change(ASSET_NULL, BANK)])).toBeNull();
  });

  it('refuses when MEMBERSHIP flips even though the line keeps its class (debtors re-typed to expense)', () => {
    const debtors = { accountType: 'asset', accountSubtype: 'receivable' };
    const asExpense = { accountType: 'expense', accountSubtype: 'receivable' };
    expect(lineReclassifies({ vatType: 'zero_rated', debit: 1, credit: 0 }, debtors, asExpense)).toBe(false);
    expect(decideLockedReclass([row({ memberBefore: true, memberAfter: false, vatType: 'zero_rated' })],
      [change(debtors as never, asExpense as never)]))
      .toMatchObject({ id: 'lock-1', accountCode: '1300', membershipFlips: true, lines: 1 });
  });

  it('refuses when a folded-in journal\'s changing line changes class', () => {
    expect(decideLockedReclass([row({ memberBefore: true, memberAfter: true })], [change(ASSET_NULL, BANK)]))
      .toMatchObject({ membershipFlips: false, lines: 1 });
  });

  it('does not refuse a folded-in journal whose changing line keeps its class', () => {
    expect(decideLockedReclass([row({ memberBefore: true, memberAfter: true })], [change(EXPENSE, EXPENSE2)])).toBeNull();
  });

  it('judges each row by ITS account\'s change, and reports the first lock only', () => {
    const OTHER_ACC = '33333333-3333-4333-8333-333333333333';
    const out = decideLockedReclass([
      row({ memberBefore: true, memberAfter: true }),
      row({ memberBefore: true, memberAfter: true, accountId: OTHER_ACC }),
      row({ lockId: 'lock-2', periodStart: '2026-07-01', periodEnd: '2026-08-31', memberBefore: true, memberAfter: false }),
    ], [change(EXPENSE, EXPENSE2), change(ASSET_NULL, BANK, OTHER_ACC)]);
    expect(out).toMatchObject({ id: 'lock-1', lines: 1 });
  });
});

describe('findLockedReclassification — the query', () => {
  it('passes ALL changes into one query, reads ACTIVE locks and POSTED journals of THIS tenant, DISTINCT', async () => {
    const OTHER_ACC = '33333333-3333-4333-8333-333333333333';
    await findLockedReclassification(CO, [change(ASSET_NULL, BANK), change(EXPENSE, EXPENSE2, OTHER_ACC)]);
    expect(h.calls[0]!.text).toMatch(/pg_advisory_xact_lock_shared/);
    const q = h.calls.find((c) => /FROM gl_journal_lines l/.test(c.text))!;
    expect(h.calls.filter((c) => /FROM gl_journal_lines l/.test(c.text))).toHaveLength(1);
    expect(q.text).toMatch(/SELECT DISTINCT jr\.lock_id/);
    expect(q.text).toMatch(/vpl\.unlocked_at IS NULL/);
    expect(q.text).toMatch(/e\.status = 'posted'/);
    expect(q.text).toMatch(/l\.company_id = \?::UUID AND l\.gl_account_id = ANY/);
    expect(q.values).toContain(CO);
    expect(q.values).toContainEqual([ACC, OTHER_ACC]);
  });

  it('collapses several entries for one account to the LAST (its final attributes)', async () => {
    // Last is unchanged → nothing to ask.
    expect(await findLockedReclassification(CO, [change(ASSET_NULL, BANK), change(EXPENSE, EXPENSE)])).toBeNull();
    expect(h.calls).toHaveLength(0);
    // Last is a real change → one account in the query, with the LAST attributes.
    await findLockedReclassification(CO, [change(EXPENSE, EXPENSE2), change(ASSET_NULL, BANK)]);
    const ch = h.calls.find((c) => /unnest/.test(c.text))!;
    expect(ch.values).toEqual([[ACC], ['asset'], [null], ['asset'], ['bank']]);
  });

  it('asks nothing when no attribute actually changes', async () => {
    expect(await findLockedReclassification(CO, [change(EXPENSE, EXPENSE)])).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('maps rows into the decision', async () => {
    h.rows = [{ lock_id: 'L', period_start: '2026-05-01', period_end: '2026-06-30', member_before: false,
      member_after: false, account_id: ACC, vat_type: null, sign: 1 }];
    expect(await findLockedReclassification(CO, [change(ASSET_NULL, BANK)])).toBeNull();
    h.rows = [{ ...(h.rows[0] as object), member_before: true, member_after: true }];
    expect(await findLockedReclassification(CO, [change(ASSET_NULL, BANK)])).toMatchObject({ id: 'L', lines: 1 });
  });
});

describe('assertAccountChangesKeepVatLocks — runs on the caller\'s transaction', () => {
  it('sends the shared advisory lock and the check query through `q`, never the pool `sql`', async () => {
    const onTx: string[] = [];
    const q = async (strings: TemplateStringsArray) => { onTx.push(strings.join('?')); return []; };
    await assertAccountChangesKeepVatLocks(CO, [change(ASSET_NULL, BANK)], q);
    expect(onTx.some((t) => /pg_advisory_xact_lock_shared/.test(t))).toBe(true);
    expect(onTx.some((t) => /FROM gl_journal_lines l/.test(t))).toBe(true);
    expect(h.calls.filter((c) => /pg_advisory_xact_lock_shared|FROM gl_journal_lines l/.test(c.text))).toHaveLength(0);
  });
});
