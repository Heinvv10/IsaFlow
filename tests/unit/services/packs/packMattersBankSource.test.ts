/**
 * THE UNRECONCILED-BANK MATTER, READ THROUGH THE REAL STATUS SERVICE.
 *
 * `packMatters.test.ts` mocks `getBankAccountsStatus` and used to hand back
 * rows keyed `unreconciled_count` / `unreconciled_balance`. Those are the
 * COLUMN names. The service maps every row to camelCase before returning it,
 * so the keys `unreconciledBankMatters` read were never present: the count
 * was always 0 and this matter could not fire on any tenant, while its tests
 * passed. A mock shaped by the consumer's guess proves the guess.
 *
 * Here only `sql` is stubbed. The rows are the columns the query selects, and
 * the real mapper stands between them and the pack.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeriodWindow } from '@/modules/accounting/services/reports/priorPeriod';

const { sqlSpy, agingSpy } = vi.hoisted(() => ({ sqlSpy: vi.fn(), agingSpy: vi.fn() }));

vi.mock('@/lib/neon', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sql: sqlSpy,
}));
vi.mock('@/modules/accounting/services/reports/agingReportService', () => ({
  getAgingReport: agingSpy,
}));
vi.mock('@/modules/accounting/services/reports/unusualJournalsService', () => ({
  getUnusualJournals: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/reports/statutoryFilingsService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOverdueStatutoryFilings: vi.fn(async () => []),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildMatters } from '@/modules/accounting/services/packs/pages/packMatters';
import { mattersTableMm, selectPrintedMatters } from '@/modules/accounting/services/packs/pages/packMattersPrinted';
import { BOARD_DECISIONS } from '@/modules/accounting/services/packs/pages/packMatterDecisions';
import { NO_PRIOR_MEETING_RECORD, type PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';

const window: PeriodWindow = { start: '2026-01-01', end: '2026-08-31' };

/** One row as `bankAccountStatusService`'s query returns it, before mapping. */
function bankRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acc-1', account_code: '1110', account_name: 'Current account', description: null,
    is_active: true, bank_account_number: null, bank_name: null, bank_branch_name: null,
    bank_branch_code: null, bank_account_type: 'current', bank_is_default: true,
    bank_default_payment_method: 'eft', bank_opening_balance: 0, bank_opening_balance_date: null,
    txn_count: 0, total_debits: 0, total_credits: 0, balance: 0, reconciled_balance: 0,
    unreconciled_balance: 0, unreconciled_count: 0, unallocated_count: 0, allocated_count: 0,
    suggested_count: 0, first_date: null, last_date: null,
    group_id: null, group_name: null, group_code: null,
    ...over,
  };
}

async function bankMatter(rows: Array<Record<string, unknown>>) {
  sqlSpy.mockResolvedValue(rows);
  const { matters } = await buildMatters('c1', window);
  return matters.find((m) => m.issue.includes('unreconciled bank item'));
}

beforeEach(() => {
  vi.clearAllMocks();
  agingSpy.mockResolvedValue({
    asAt: window.end, buckets: [],
    totals: { current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, disputed: 0, total: 0 },
    excluded: [], excludedTotal: 0, entityUniverse: 0, unappliedReceipts: 0, subledgerTotal: 0,
    postedThrough: null,
  });
});

describe('the unreconciled bank matter', () => {
  it('fires on the rows the status service actually returns', async () => {
    const matter = await bankMatter([
      bankRow({ unreconciled_balance: '-15000.00', unallocated_count: 3, unreconciled_count: 3 }),
    ]);
    expect(matter, 'the matter did not fire: the service\'s row keys were not read').toBeDefined();
    expect(matter!.quantum).toBe(15_000);
  });

  it('counts the same transactions the amount is summed over', async () => {
    // The amount is every posted line with no journal line that is not
    // excluded. The service's `unreconciled_count` is a different population
    // (status imported or allocated), so pairing the two put a count and an
    // amount of different things in one sentence. Suggested plus unallocated
    // is exactly the amount's population, split in two.
    const matter = await bankMatter([
      bankRow({ id: 'a', unreconciled_balance: 4_000, suggested_count: 1, unallocated_count: 0, unreconciled_count: 7 }),
      bankRow({ id: 'b', unreconciled_balance: 91_000, suggested_count: 5, unallocated_count: 6, unreconciled_count: 2 }),
      // Reconciled in full: counted by neither figure, and not an account
      // the sentence may claim.
      bankRow({ id: 'c', unreconciled_balance: 0, suggested_count: 0, unallocated_count: 0, unreconciled_count: 9 }),
    ]);
    expect(matter!.issue).toMatch(/^12 unreconciled bank items across 2 bank accounts/);
    expect(matter!.quantum).toBe(95_000);
  });

  it('says the figure is as at extraction, because the service cannot read an earlier date', async () => {
    // `getBankAccountsStatus` takes no as-at date. A pack dated to an earlier
    // period end therefore prints the bank position at the moment it was
    // extracted, and the sentence has to say so rather than let the cover's
    // date stand for it.
    const matter = await bankMatter([bankRow({ unreconciled_balance: 500, unallocated_count: 1 })]);
    expect(matter!.issue).toBe(
      '1 unreconciled bank item across 1 bank account, as at the time this pack was extracted '
      + 'rather than at the period end; the amount is the net unmatched amount on each account, '
      + 'added without regard to sign',
    );
  });

  /**
   * THE AMOUNT IS A NET PER ACCOUNT, AND A NET CAN BE NIL OVER ANY NUMBER OF
   * ITEMS. The matter was suppressed whenever the amount rounded to nothing,
   * so an unmatched receipt and an unmatched payment of the same size hid
   * themselves, and every other unreconciled item on the account with them.
   * What a board is asked about is the backlog: the COUNT raises the matter.
   */
  it('is raised by the count alone, and says so, where the items net to nil', async () => {
    const matter = await bankMatter([
      bankRow({ unreconciled_balance: '0.00', suggested_count: 1, unallocated_count: 3 }),
    ]);
    expect(matter, 'four unreconciled items raised no matter because they net to nil').toBeDefined();
    expect(matter!.issue).toBe(
      '4 unreconciled bank items across 1 bank account, as at the time this pack was extracted '
      + 'rather than at the period end; receipts and payments among them net to nil on each '
      + 'account, so no amount is stated',
    );
    // NOT STATED, NOT NIL. A quantum of 0 printed the measured-nil dash under
    // a sentence saying no amount is stated, and ranked the matter last among
    // the quantified ones — the first row page 11 drops when it runs short.
    expect(matter!.quantum).toBeNull();
  });

  it('survives a page 11 that has room for only one row, where it nets to nil', async () => {
    const backlog = (await bankMatter([
      bankRow({ unreconciled_balance: 0, suggested_count: 2, unallocated_count: 9 }),
    ]))!;
    const journal = (n: number): PackMatter => ({
      kind: 'finding', issue: `Journal JE-${n} (large round-number amount): accrual`, quantum: 50_000 * n,
      owner: 'Finance', movement: NO_PRIOR_MEETING_RECORD, decisionRequired: BOARD_DECISIONS.unusualJournal,
    });
    const all = [journal(3), journal(2), journal(1), backlog];
    // Room for exactly one row of the table.
    const budget = mattersTableMm([backlog]);
    expect(mattersTableMm([journal(3), backlog])).toBeGreaterThan(budget);

    const { printed, omitted } = selectPrintedMatters(all, budget);
    expect(printed).toEqual([backlog]);
    expect(omitted).toHaveLength(3);
  });

  it('adds a net inflow on one account to a net outflow on another without letting them cancel', async () => {
    const matter = await bankMatter([
      bankRow({ id: 'a', unreconciled_balance: -5_000, unallocated_count: 2 }),
      bankRow({ id: 'b', unreconciled_balance: 3_000, unallocated_count: 1 }),
    ]);
    expect(matter!.quantum).toBe(8_000);
    expect(matter!.issue).toMatch(/^3 unreconciled bank items across 2 bank accounts/);
    expect(matter!.issue).toMatch(/net unmatched amount on each account, added without regard to sign$/);
  });

  it('counts the items on an account that nets to nil beside one that does not', async () => {
    const matter = await bankMatter([
      bankRow({ id: 'a', unreconciled_balance: 0, unallocated_count: 6 }),
      bankRow({ id: 'b', unreconciled_balance: 750, unallocated_count: 1 }),
    ]);
    expect(matter!.issue).toMatch(/^7 unreconciled bank items across 2 bank accounts/);
    expect(matter!.quantum).toBe(750);
    expect(matter!.issue).not.toMatch(/net to nil/);
  });

  it('groups a count in the thousands the way the pack groups every figure', async () => {
    const matter = await bankMatter([
      bankRow({ unreconciled_balance: 91_000, suggested_count: 12, unallocated_count: 1_000 }),
    ]);
    // U+00A0, the pack's one separator: "1 012", never "1012".
    expect(matter!.issue.startsWith('1\u00a0012 unreconciled bank items across 1 bank account')).toBe(true);
  });

  it('is absent where every account is reconciled', async () => {
    expect(await bankMatter([bankRow(), bankRow({ id: 'b' })])).toBeUndefined();
  });

  it('still raises the matter for a closed account that carries unreconciled lines', async () => {
    // `is_active` decides whether an account is offered in a picker. A
    // deactivated account still holds its unmatched lines, and the status
    // service leaves such accounts out unless a caller asking about money
    // opts in — which this one did not.
    const matter = await bankMatter([
      bankRow({ is_active: false, unreconciled_balance: 8_250, unallocated_count: 2 }),
    ]);
    expect(matter!.issue).toMatch(/^2 unreconciled bank items across 1 bank account/);
    // The stub answers whatever is asked, so the opt-in is read where it is
    // made: the value bound to the query's inactive-accounts switch.
    const [strings, ...values] = sqlSpy.mock.calls[0] as [readonly string[], ...unknown[]];
    const at = strings.findIndex((fragment) => /AND \($/.test(fragment));
    expect(strings[at + 1]).toMatch(/^::boolean = true OR ga\.is_active = TRUE\)/);
    expect(values[at]).toBe(true);
  });

  it('asks the status service about the pack\'s own company', async () => {
    await bankMatter([bankRow()]);
    const [, ...values] = sqlSpy.mock.calls[0] as [readonly string[], ...unknown[]];
    expect(values).toContain('c1');
  });
});
