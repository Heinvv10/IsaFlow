/**
 * The pack's Cash Flow, Debtors/Creditors Ageing and Bank Reconciliation sections: the reports' own figures,
 * cell for cell, as the pack prints them. (The same cells against the services on real PostgreSQL:
 * tests/integration/management-pack-reports.int.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import type { CashFlowDirectReport } from '@/modules/accounting/services/afs/cashFlowDirectService';
import type { BankReconciliation } from '@/modules/accounting/types/bank.types';
import type { NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';
import {
  AGEING_HEADERS, AGEING_TOP, ageingBlocks, ageingFigures, bankReconciliationBlocks, bankReconciliationFigures, cashFlowBlocks, cashFlowFigures,
  latestReconciliations, type AgeingData, type ReconciliationData,
} from '@/modules/accounting/services/afs/managementPackReportSections';

const plain = (s: string) => s.replace(/ /g, ' ');
const tableOf = (blocks: ReturnType<typeof cashFlowBlocks>): NoteContentTable => {
  const t = blocks.find((b): b is NoteContentTable => b.type === 'table');
  if (!t) throw new Error('no table');
  return { ...t, rows: t.rows.map((r) => r.map(plain)) };
};
const texts = (blocks: ReturnType<typeof cashFlowBlocks>) => blocks.flatMap((b) => (b.type === 'paragraph' ? [plain(b.text)] : []));

const cash = (over: Partial<CashFlowDirectReport> = {}): CashFlowDirectReport => ({
  periodStart: '2026-09-01', periodEnd: '2026-09-30', openingCash: 1000,
  operatingItems: [{ cashGroup: 'cash_received_from_customers', label: 'Cash received from customers', amount: 5000 }, { cashGroup: 'cash_paid_to_suppliers', label: 'Cash paid to suppliers', amount: -2000 }],
  operatingTotal: 3000, investingItems: [{ cashGroup: 'investing', label: 'Net investing cash flows', amount: -500 }], investingTotal: -500,
  financingItems: [], financingTotal: 0, netChange: 2500, closingCash: 3500, ...over,
});

describe('cash flow', () => {
  it('prints the report\'s groups, items and totals, opening to closing', () => {
    const t = tableOf(cashFlowBlocks([{ label: 'This month', report: cash() }], false));
    expect(t.headers).toEqual(['', 'This month']);
    expect(t.rows).toEqual([
      ['Opening cash', 'R 1 000.00'],
      ['Operating activities', ''], ['Cash received from customers', 'R 5 000.00'], ['Cash paid to suppliers', '−R 2 000.00'], ['Net cash from operating activities', 'R 3 000.00'],
      ['Investing activities', ''], ['Net investing cash flows', '−R 500.00'], ['Net cash from investing activities', '−R 500.00'],
      ['Net change in cash', 'R 2 500.00'], ['Closing cash', 'R 3 500.00'],
    ]);
    expect(t.rowKinds).toEqual(['subtotal', 'heading', 'line', 'line', 'subtotal', 'heading', 'line', 'subtotal', 'subtotal', 'total']);
  });

  it('says it is the direct method', () => {
    expect(texts(cashFlowBlocks([{ label: 'This month', report: cash() }], false))).toEqual(['Direct method: the cash received and paid in the month, grouped by what it was for.']);
  });

  it('uses the report\'s closing cash, never a sum of its own', () => {
    expect(tableOf(cashFlowBlocks([{ label: 'x', report: cash({ closingCash: 1 }) }], false)).rows.at(-1)).toEqual(['Closing cash', 'R 1.00']);
  });

  it('adds the prior month and the same month last year with the change', () => {
    const t = tableOf(cashFlowBlocks([
      { label: 'This month', report: cash() }, { label: 'Prior month', report: cash({ openingCash: 0, closingCash: 900 }) },
      { label: 'Same month last year', report: cash({ closingCash: 3000, openingCash: 800 }) },
    ], true));
    expect(t.headers).toEqual(['', 'This month', 'Prior month', 'Same month last year', 'Change on last year']);
    expect(t.rows.at(-1)).toEqual(['Closing cash', 'R 3 500.00', 'R 900.00', 'R 3 000.00', 'R 500.00']);
  });

  it('a month in which no cash moved says so, and still shows opening and closing', () => {
    const none = cash({ operatingItems: [], operatingTotal: 0, investingItems: [], investingTotal: 0, netChange: 0, closingCash: 1000 });
    const blocks = cashFlowBlocks([{ label: 'This month', report: none }], false);
    expect(texts(blocks)).toEqual(['Direct method: the cash received and paid in the month, grouped by what it was for.', 'No cash moved in this period.']);
    expect(tableOf(blocks).rows.map((r) => r[0])).toEqual(['Opening cash', 'Net change in cash', 'Closing cash']);
  });

  it('the figures behind it are the report\'s totals', () => {
    expect(cashFlowFigures(cash())).toMatchObject({ openingCash: 1000, operatingTotal: 3000, netChange: 2500, closingCash: 3500 });
    expect(cashFlowFigures(undefined)).toEqual({});
  });
});

const bucket = (name: string, total: number, over: Record<string, number> = {}) => ({
  entityId: name, entityName: name, current: total, days30: 0, days60: 0, days90: 0, days120Plus: 0, total, ...over,
});
const ageing = (buckets: ReturnType<typeof bucket>[], over: Partial<AgeingData> = {}): AgeingData => ({ asAt: '2026-09-30', buckets, unapplied: 0, creditOnly: [], ...over });
const cents = (s: string | undefined) => Math.round(Number((s ?? '').replace(/[^0-9.−-]/g, '').replace('−', '-')) * 100);

describe('ageing', () => {
  it('uses the Aged Debtors screen\'s labels', () => {
    expect([...AGEING_HEADERS]).toEqual(['Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days', 'Total']);
    expect(tableOf(ageingBlocks(ageing([bucket('A', 1)]), 'ar')).headers).toEqual(['Customer', ...AGEING_HEADERS]);
  });

  it('lists the balances by size and ends on the sum of the rows', () => {
    const t = tableOf(ageingBlocks(ageing([bucket('Small', 100), bucket('Big', 900, { current: 400, days30: 300, days60: 200 })]), 'ar'));
    expect(t.rows).toEqual([
      ['Big', 'R 400.00', 'R 300.00', 'R 200.00', 'R 0.00', 'R 0.00', 'R 900.00'],
      ['Small', 'R 100.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 100.00'],
      ['Total', 'R 500.00', 'R 300.00', 'R 200.00', 'R 0.00', 'R 0.00', 'R 1 000.00'],
    ]);
    expect(t.rowKinds).toEqual(['line', 'line', 'total']);
  });

  it('ranks by size, a credit balance counting by its absolute value', () => {
    const rows = tableOf(ageingBlocks(ageing([bucket('Small', 100), bucket('Credit', -900), bucket('Mid', 300)]), 'ar')).rows;
    expect(rows.map((r) => r[0])).toEqual(['Credit', 'Mid', 'Small', 'Total']);
  });

  it('folds the balances beyond the largest ten into one row, and top + fold = Total in EVERY column', () => {
    const many = Array.from({ length: AGEING_TOP + 3 }, (_, i) => bucket(`C${String(i).padStart(2, '0')}`, 1000 - i, { current: 500 - i, days30: 100 + i, days60: 50, days90: 25 + i, days120Plus: 325 - i }));
    const blocks = ageingBlocks(ageing(many), 'ar');
    const t = tableOf(blocks);
    expect(t.rows).toHaveLength(AGEING_TOP + 2);
    expect(t.rows[AGEING_TOP]?.[0]).toBe('Other customers (3)');
    for (let col = 1; col < t.headers.length; col++) {
      const body = t.rows.slice(0, -1).reduce((sum, r) => sum + cents(r[col]), 0);
      expect(body, t.headers[col]).toBe(cents(t.rows.at(-1)?.[col]));
    }
    expect(texts(blocks)).toEqual([`${many.length} customers have a balance; the ${AGEING_TOP} largest are listed.`]);
  });

  it('suppliers, and the words for what sits unapplied', () => {
    const blocks = ageingBlocks(ageing([bucket('S', 500)], { unapplied: 75 }), 'ap');
    expect(tableOf(blocks).headers[0]).toBe('Supplier');
    expect(texts(blocks)).toEqual(['Unapplied payments and credit notes standing against suppliers: R 75.00. The columns above are before them.']);
    expect(texts(ageingBlocks(ageing([bucket('S', 500)], { unapplied: 75 }), 'ar'))[0]).toContain('Unapplied receipts and credit notes standing against customers');
  });

  it('Total includes what is disputed (it is still owed); Disputed is a column beside the ages, so the row foots', () => {
    // The service takes the disputed 30 out of the age buckets: 70 + 30 = 100 owed.
    const t = tableOf(ageingBlocks(ageing([bucket('A', 70, { current: 70, disputed: 30 })]), 'ar'));
    expect(t.headers).toEqual(['Customer', 'Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days', 'Disputed', 'Total']);
    expect(t.rows[0]).toEqual(['A', 'R 70.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 30.00', 'R 100.00']);
    expect(t.rows.at(-1)).toEqual(['Total', 'R 70.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 30.00', 'R 100.00']);
    for (const r of t.rows) expect(cents(r[1]) + cents(r[2]) + cents(r[3]) + cents(r[4]) + cents(r[5]) + cents(r[6])).toBe(cents(r[7]));
  });

  it('does not double-count: a service total that already includes the dispute gives the same row', () => {
    const net = tableOf(ageingBlocks(ageing([bucket('A', 70, { current: 70, disputed: 30 })]), 'ar')).rows;
    const gross = tableOf(ageingBlocks(ageing([bucket('A', 100, { current: 70, disputed: 30 })]), 'ar')).rows;
    expect(gross).toEqual(net);
    expect(gross.at(-1)?.at(-1)).toBe('R 100.00');
    expect(ageingFigures(ageing([bucket('A', 100, { current: 70, disputed: 30 })]))).toMatchObject({ totals: { total: 100 }, largestBalances: [100] });
  });

  it('a Disputed column only when debtors have disputes, and never for suppliers', () => {
    expect(tableOf(ageingBlocks(ageing([bucket('A', 100)]), 'ar')).headers).not.toContain('Disputed');
    expect(tableOf(ageingBlocks(ageing([bucket('A', 100, { disputed: 30 })]), 'ap')).headers).toEqual(['Supplier', ...AGEING_HEADERS]);
  });

  it('entities with only unapplied credit and no open document are listed beside the unapplied note', () => {
    const blocks = ageingBlocks(ageing([bucket('A', 100)], { unapplied: -60, creditOnly: [{ name: 'Credit Only Co', amount: -40 }, { name: 'Other Credit', amount: -20 }] }), 'ar');
    expect(texts(blocks)).toEqual([
      'Unapplied receipts and credit notes standing against customers: −R 60.00. The columns above are before them.',
      'Customers with credit and no open document, so in no row above: Credit Only Co (−R 40.00), Other Credit (−R 20.00).',
    ]);
    const empty = ageingBlocks(ageing([], { creditOnly: [{ name: 'Only Credit', amount: -5 }] }), 'ap');
    expect(texts(empty)).toEqual(['No open supplier balances at 30 September 2026.', 'Suppliers with credit and no open document, so in no row above: Only Credit (−R 5.00).']);
  });

  it('a long credit-only list is shortened', () => {
    const many = Array.from({ length: AGEING_TOP + 4 }, (_, i) => ({ name: `E${i}`, amount: -(i + 1) }));
    expect(texts(ageingBlocks(ageing([bucket('A', 1)], { creditOnly: many }), 'ar')).at(-1)).toMatch(/ and 4 more\.$/);
  });

  it('no balances prints a sentence with the date, and still says what sits unapplied', () => {
    expect(texts(ageingBlocks(ageing([]), 'ar'))).toEqual(['No open customer balances at 30 September 2026.']);
    expect(texts(ageingBlocks(ageing([], { unapplied: 40 }), 'ap'))).toEqual([
      'No open supplier balances at 30 September 2026.',
      'Unapplied payments and credit notes standing against suppliers: R 40.00. The columns above are before them.',
    ]);
  });

  it('what the AI is told has no name in it', () => {
    const figures = ageingFigures(ageing([bucket('Alpha (Pty) Ltd', 100), bucket('Beta CC', 300)], { unapplied: 20 }));
    const f = ageingFigures(ageing([bucket('Alpha (Pty) Ltd', 100, { disputed: 25 }), bucket('Beta CC', 300)], { unapplied: 20, creditOnly: [{ name: 'Gamma Credit', amount: -8 }] }));
    expect(f).toMatchObject({ asAt: '2026-09-30', entities: 2, unapplied: 20, largestBalances: [300, 125], totals: { total: 425, disputed: 25 }, creditOnlyEntities: 1, creditOnlyTotal: -8 });
    expect(JSON.stringify(f)).not.toMatch(/Alpha|Beta|Gamma/);
    expect(figures).toMatchObject({ entities: 2 });
    expect(JSON.stringify(figures)).not.toMatch(/Alpha|Beta/);
    expect(ageingFigures(undefined)).toEqual({});
  });
});

const rec = (over: Partial<BankReconciliation>): BankReconciliation => ({
  id: 'r', bankAccountId: 'a', statementDate: '2026-09-30', statementBalance: 1000, glBalance: 990, reconciledBalance: 995, difference: 0,
  status: 'completed', startedBy: 'u', startedAt: '2026-10-01', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01', bankAccountName: 'Main', ...over,
});
const data = (sessions: BankReconciliation[], accounts: Array<{ id: string; name: string }> = [{ id: 'a', name: 'Main' }]): ReconciliationData => ({ sessions, accounts });

describe('bank reconciliation', () => {
  it('four figures: statement, GL, the stored reconciled balance and statement less GL (computed)', () => {
    const t = tableOf(bankReconciliationBlocks(data([rec({})]), '2026-09-30'));
    expect(t.headers).toEqual(['Bank account', 'Statement date', 'Statement balance', 'GL balance', 'Reconciled balance', 'Statement less GL']);
    expect(t.rows).toEqual([['Main', '30 September 2026', 'R 1 000.00', 'R 990.00', 'R 995.00', 'R 10.00']]);
    expect(texts(bankReconciliationBlocks(data([rec({})]), '2026-09-30')).at(-1)).toContain('stored when it was made, as at its statement date');
  });

  it('the latest COMPLETED session of each account on or before the month end, never a later one', () => {
    const all = [
      rec({ id: '1', statementDate: '2026-08-31' }), rec({ id: '2', statementDate: '2026-09-30', statementBalance: 1111 }), rec({ id: '3', statementDate: '2026-10-31' }),
      rec({ id: '4', bankAccountId: 'b', bankAccountName: 'Savings', statementDate: '2026-09-15', statementBalance: 50 }),
    ];
    expect(latestReconciliations(all, '2026-09-30').map((r) => r.id)).toEqual(['2', '4']);
    const t = tableOf(bankReconciliationBlocks(data(all, [{ id: 'a', name: 'Main' }, { id: 'b', name: 'Savings' }]), '2026-09-30'));
    expect(t.rows.map((r) => [r[0], r[2]])).toEqual([['Main', 'R 1 111.00'], ['Savings', 'R 50.00']]);
  });

  it('an in-progress session is not the figure; a note says it exists', () => {
    const all = [rec({ id: 'done', statementDate: '2026-08-31', statementBalance: 700 }), rec({ id: 'open', statementDate: '2026-09-20', statementBalance: 999, status: 'in_progress' })];
    const blocks = bankReconciliationBlocks(data(all), '2026-09-30');
    expect(tableOf(blocks).rows[0]?.[2]).toBe('R 700.00');
    expect(texts(blocks)).toContain('Main: a reconciliation to 20 September 2026 is in progress and not included.');
    // An in-progress session OLDER than the completed one is not news.
    const older = bankReconciliationBlocks(data([rec({ id: 'done', statementDate: '2026-09-25' }), rec({ id: 'old', statementDate: '2026-09-10', status: 'in_progress' })]), '2026-09-30');
    expect(texts(older).some((t) => t.includes('in progress'))).toBe(false);
  });

  it('a bank account with no completed reconciliation is listed as "No reconciliation"', () => {
    const t = tableOf(bankReconciliationBlocks(data([rec({})], [{ id: 'a', name: 'Main' }, { id: 'z', name: 'Never Reconciled' }]), '2026-09-30'));
    expect(t.rows.map((r) => r[0])).toEqual(['Main', 'Never Reconciled']);
    expect(t.rows[1]).toEqual(['Never Reconciled', 'No reconciliation', '—', '—', '—', '—']);
    // One with only an in-progress session is just as unreconciled, and says so.
    const onlyOpen = bankReconciliationBlocks(data([rec({ status: 'in_progress' })]), '2026-09-30');
    expect(tableOf(onlyOpen).rows[0]?.[1]).toBe('No reconciliation');
    expect(texts(onlyOpen)).toContain('Main: a reconciliation to 30 September 2026 is in progress and not included.');
  });

  it('an account known only from its sessions is still listed, and a company with none says so', () => {
    expect(tableOf(bankReconciliationBlocks(data([rec({})], []), '2026-09-30')).rows[0]?.[0]).toBe('Main');
    expect(texts(bankReconciliationBlocks(data([], []), '2026-09-30'))).toEqual(['The company has no bank accounts.']);
  });

  it('two sessions on one date: the later created by instant wins, whatever its text says (String(Date) shapes)', () => {
    // "Thu Feb 25 ..." sorts after "Fri Feb 26 ..." as text.
    const thursday = String(new Date('2027-02-25T10:00:00Z'));
    const friday = String(new Date('2027-02-26T10:00:00Z'));
    const sessions = [rec({ id: 'thu', createdAt: thursday, statementBalance: 111 }), rec({ id: 'fri', createdAt: friday, statementBalance: 222 })];
    expect(thursday > friday).toBe(true);
    expect(latestReconciliations(sessions, '2026-09-30').map((r) => r.id)).toEqual(['fri']);
    expect(latestReconciliations([...sessions].reverse(), '2026-09-30').map((r) => r.id)).toEqual(['fri']);
  });

  it('identical statement date and instant: the higher id wins, in either order', () => {
    const a = rec({ id: 'a1' });
    const b = rec({ id: 'b2' });
    expect(latestReconciliations([a, b], '2026-09-30').map((r) => r.id)).toEqual(['b2']);
    expect(latestReconciliations([b, a], '2026-09-30').map((r) => r.id)).toEqual(['b2']);
  });

  it('the figures behind it honour the month end and count the unreconciled accounts', () => {
    const sessions = [rec({ statementDate: '2026-09-30' }), rec({ id: 'later', statementDate: '2026-10-31', statementBalance: 9 })];
    expect(bankReconciliationFigures(data(sessions, [{ id: 'a', name: 'Main' }, { id: 'z', name: 'Z' }]), '2026-09-30')).toEqual({
      asAt: '2026-09-30',
      accounts: [{ statementDate: '2026-09-30', statementBalance: 1000, glBalance: 990, reconciledBalance: 995, statementLessGl: 10 }],
      accountsWithoutReconciliation: 1,
    });
    expect(bankReconciliationFigures(undefined, '2026-09-30')).toEqual({});
  });

  it('what the AI is told has no bank account name or number in it', () => {
    const named = [rec({ bankAccountName: 'ZZPRIVATE FNB 62123456789' })];
    const f = bankReconciliationFigures(data(named, [{ id: 'a', name: 'ZZPRIVATE FNB 62123456789' }]), '2026-09-30');
    expect(JSON.stringify(f)).not.toMatch(/ZZPRIVATE|62123456789/);
    expect(f).toMatchObject({ accounts: [{ statementBalance: 1000 }] });
  });
});
