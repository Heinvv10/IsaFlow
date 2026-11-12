// tests/unit/services/dashboard/attentionShape.test.ts
// The one "Needs attention" list on the dashboard: pure shaping, no mocks.
import { describe, it, expect } from 'vitest';
import {
  shapeAttention,
  type AttentionInput,
  type AttentionItem,
  type OpenPayRun,
} from '@/modules/accounting/services/dashboard/attentionShape';
import type { WorkItem } from '@/modules/bureau/services/bureauWorkTypes';
import { formatMoney } from '@/lib/money/formatMoney';

const NOON = (d: string) => new Date(`${d}T10:00:00Z`);

const work = (over: Partial<WorkItem>): WorkItem => ({
  bureauId: '', bureauName: '', companyId: 'c1', companyName: '',
  task: 'Task', detail: 'Detail', dueAt: null, href: '/somewhere', severity: 'info',
  ...over,
});

function input(over: Partial<AttentionInput> = {}): AttentionInput {
  const asAt = over.asAt ?? '2026-11-12';
  return {
    asAt,
    today: NOON(asAt),
    counts: { draftInvoices: 0, draftBills: 0, draftJournals: 0, billsDueNext7Days: 0, billsOverdue: 0 },
    overdueInvoices: { count: 0, amount: 0 },
    unreconciledBankTxns: 0,
    openPriorPeriods: 0,
    payRuns: [],
    work: [],
    cash: { cash: 0, payroll: null, vat: null },
    ...over,
  };
}

const run = (id: string, periodYear: number, periodMonth: number, status: OpenPayRun['status']): OpenPayRun =>
  ({ id, periodYear, periodMonth, status });

const keys = (items: AttentionItem[]) => items.map((i) => i.key);
const text = (i: AttentionItem) => `${i.label} ${i.detail ?? ''}`;

describe('shapeAttention: pay runs anchored on the current period, not 2020', () => {
  const payRuns = [
    run('r2020', 2020, 1, 'approved'),
    run('rsep', 2026, 9, 'approved'),
    run('roct', 2026, 10, 'approved'),
    run('rnov', 2026, 11, 'draft'),
    run('rfeb27', 2027, 2, 'calculated'),
  ];

  it('lists only this month and last month, one older summary row, nothing in the future', () => {
    const items = shapeAttention(input({ payRuns }));
    const runRows = items.filter((i) => i.key.startsWith('pay-run-'));
    expect(runRows.map((i) => i.key).sort()).toEqual(['pay-run-rnov', 'pay-run-roct']);
    expect(runRows.find((i) => i.key === 'pay-run-roct')).toMatchObject({
      label: 'October 2026 pay run', detail: 'Approved, not paid', area: 'Payroll', href: '/payroll/runs/roct',
    });
    expect(runRows.find((i) => i.key === 'pay-run-rnov')).toMatchObject({
      label: 'November 2026 pay run', detail: 'Draft',
    });
    const older = items.filter((i) => i.key === 'pay-runs-older');
    expect(older).toHaveLength(1);
    expect(older[0]).toMatchObject({
      label: '2 older pay runs still open', detail: 'Oldest: January 2020', severity: 'info', href: '/payroll/runs',
    });
    expect(items.some((i) => text(i).includes('2027'))).toBe(false);
    const with2020 = items.filter((i) => text(i).includes('2020'));
    expect(with2020.map((i) => i.key)).toEqual(['pay-runs-older']);
  });

  it('dates each run at the end of the month after its period and grades it against today', () => {
    const items = shapeAttention(input({ payRuns }));
    const oct = items.find((i) => i.key === 'pay-run-roct')!;
    const nov = items.find((i) => i.key === 'pay-run-rnov')!;
    // Oct is due 30 Nov (18 days away): info. Nov is due 31 Dec: info.
    expect(oct.dueAt?.slice(0, 7)).toBe('2026-11');
    expect(nov.dueAt?.slice(0, 7)).toBe('2026-12');
    expect(oct.severity).toBe('info');
    const late = shapeAttention(input({ asAt: '2026-11-28', payRuns: [run('roct', 2026, 10, 'calculated')] }));
    expect(late.find((i) => i.key === 'pay-run-roct')).toMatchObject({ severity: 'due_soon', detail: 'Calculated, not approved' });
  });

  it('keeps December and January across the year boundary', () => {
    const items = shapeAttention(input({
      asAt: '2027-01-05',
      payRuns: [run('rnov', 2026, 11, 'approved'), run('rdec', 2026, 12, 'approved'), run('rjan', 2027, 1, 'draft')],
    }));
    expect(keys(items).filter((k) => k.startsWith('pay-run-')).sort()).toEqual(['pay-run-rdec', 'pay-run-rjan']);
    expect(items.find((i) => i.key === 'pay-runs-older')).toMatchObject({ label: '1 older pay run still open', detail: 'Oldest: November 2026' });
  });

  it('no older row when nothing is older than last month', () => {
    const items = shapeAttention(input({ payRuns: [run('rnov', 2026, 11, 'draft')] }));
    expect(keys(items)).toEqual(['pay-run-rnov']);
  });
});

describe('shapeAttention: bureau work items', () => {
  it('drops pay-run and bank-report work items; passes the rest through with their text', () => {
    const items = shapeAttention(input({
      work: [
        work({ task: 'Pay run · approved', detail: 'Jan 2020', href: '/payroll/runs/x', severity: 'overdue' }),
        work({ task: 'Bank reconciliation', detail: '439 unreconciled', href: '/accounting/reports/bank-transactions' }),
        work({ task: 'Leave approvals', detail: '2 pending', href: '/payroll/leave' }),
        work({ task: 'EMP201 due', detail: 'Oct 2026', href: '/payroll/emp201', dueAt: '2026-11-07', severity: 'overdue' }),
        work({ task: 'Bills to approve', detail: '3 awaiting approval', href: '/accounting/reports/ap-aging', amount: 1200 }),
        work({ task: 'Client replies to review', detail: '1', href: '/accounting/bank/queries' }),
        work({ task: 'CIPC annual return due', detail: 'Anniversary month Mar', href: '/compliance/cipc' }),
      ],
    }));
    expect(items.some((i) => i.href.startsWith('/payroll/runs/'))).toBe(false);
    expect(items.some((i) => i.href === '/accounting/reports/bank-transactions')).toBe(false);
    const leave = items.find((i) => i.label === 'Leave approvals')!;
    expect(leave).toMatchObject({ detail: '2 pending', area: 'Payroll', href: '/payroll/leave', severity: 'info' });
    expect(items.find((i) => i.label === 'EMP201 due')).toMatchObject({ dueAt: '2026-11-07', severity: 'overdue', area: 'Payroll' });
    expect(items.find((i) => i.label === 'Bills to approve')).toMatchObject({ amount: 1200, area: 'Purchases' });
    expect(items.find((i) => i.label === 'Client replies to review')).toMatchObject({ area: 'Banking' });
    expect(items.find((i) => i.label === 'CIPC annual return due')).toMatchObject({ area: 'Compliance' });
  });

  it('tags SARS links by what they are: VAT201 is VAT, EMP201 is Payroll, the rest Compliance', () => {
    const items = shapeAttention(input({
      work: [
        work({ task: 'VAT return due', href: '/accounting/sars/vat201' }),
        work({ task: 'EMP201 due', href: '/accounting/sars/emp201' }),
        work({ task: 'Provisional tax (IRP6) due', href: '/accounting/sars' }),
      ],
    }));
    expect(items.map((i) => `${i.label}:${i.area}`)).toEqual([
      'VAT return due:VAT', 'EMP201 due:Payroll', 'Provisional tax (IRP6) due:Compliance',
    ]);
  });

  it('one bank row and one draft-invoice row however many sources mention them', () => {
    const items = shapeAttention(input({
      unreconciledBankTxns: 439,
      counts: { draftInvoices: 4, draftBills: 0, draftJournals: 0, billsDueNext7Days: 0, billsOverdue: 0 },
      work: [
        work({ task: 'Bank reconciliation', detail: '439 unreconciled', href: '/accounting/reports/bank-transactions' }),
        work({ task: 'Bank reconciliation', detail: '439 unreconciled', href: '/accounting/reports/bank-transactions' }),
      ],
    }));
    expect(new Set(keys(items)).size).toBe(items.length);
    expect(items.filter((i) => i.area === 'Banking')).toEqual([
      expect.objectContaining({ key: 'bank-unreconciled', label: '439 unreconciled bank transactions', href: '/accounting/bank-transactions' }),
    ]);
    expect(items.filter((i) => /draft invoice/.test(i.label))).toHaveLength(1);
  });

  it('identical work items collapse to one row', () => {
    const w = work({ task: 'Leave approvals', detail: '2 pending', href: '/payroll/leave' });
    expect(shapeAttention(input({ work: [w, { ...w }] }))).toHaveLength(1);
  });
});

describe('shapeAttention: VAT is one row', () => {
  const vatItem = work({ task: 'VAT return due', detail: 'Sep–Oct 2026', href: '/accounting/sars/vat201', dueAt: '2026-11-25', severity: 'info' });
  const vat = (netVat: number) => ({ periodLabel: 'Sep–Oct 2026', dueDate: '2026-11-25', netVat });

  it('carries the VAT201 net VAT as its amount when payable', () => {
    const items = shapeAttention(input({ work: [vatItem], cash: { cash: 0, payroll: null, vat: vat(5400.5) } }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: 'VAT return due', amount: 5400.5, area: 'VAT' });
  });

  it.each([[0], [-200]])('no amount when net VAT is %s', (n) => {
    const items = shapeAttention(input({ work: [vatItem], cash: { cash: 0, payroll: null, vat: vat(n) } }));
    expect(items).toHaveLength(1);
    expect(items[0]!.amount ?? null).toBeNull();
  });

  it('no amount and no extra row when the VAT section is missing', () => {
    const items = shapeAttention(input({ work: [vatItem] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.amount ?? null).toBeNull();
  });

  it('never invents a VAT row without the work item', () => {
    expect(shapeAttention(input({ cash: { cash: 0, payroll: null, vat: vat(900) } }))).toEqual([]);
  });
});

describe('shapeAttention: salary shortfall', () => {
  const payroll = (over: Partial<NonNullable<AttentionInput['cash']['payroll']>>) => ({
    runId: 'rnov', periodLabel: 'November 2026', status: 'approved' as const,
    totalRequired: 50000, canPay: false, shortfall: 20000, ...over,
  });

  it('a row when cash cannot pay the run', () => {
    const items = shapeAttention(input({ cash: { cash: 30000, payroll: payroll({}), vat: null } }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 'payroll-shortfall', area: 'Payroll', severity: 'due_soon', amount: 20000, href: '/payroll/runs/rnov',
      label: 'Cash is short for the November 2026 pay run',
    });
    expect(items[0]!.detail).toBe(`Cash ${formatMoney(30000)} against ${formatMoney(50000)} (net pay plus PAYE, UIF and SDL)`);
  });

  it('says it is an estimate only for an unapproved run', () => {
    const est = shapeAttention(input({ cash: { cash: 30000, payroll: payroll({ status: 'estimated' }), vat: null } }));
    expect(est[0]!.detail).toMatch(/ Estimate: the run is not approved yet\.$/);
    const appr = shapeAttention(input({ cash: { cash: 30000, payroll: payroll({}), vat: null } }));
    expect(appr[0]!.detail).not.toMatch(/Estimate/);
  });

  it('no row when cash covers it', () => {
    expect(shapeAttention(input({ cash: { cash: 90000, payroll: payroll({ canPay: true, shortfall: 0 }), vat: null } }))).toEqual([]);
  });
});

describe('shapeAttention: counts, plurals and order', () => {
  it('all zero gives an empty list', () => {
    expect(shapeAttention(input())).toEqual([]);
  });

  it('plurals for 1 and 2', () => {
    const one = shapeAttention(input({
      counts: { draftInvoices: 1, draftBills: 0, draftJournals: 1, billsDueNext7Days: 1, billsOverdue: 1 },
      overdueInvoices: { count: 1, amount: 10 }, unreconciledBankTxns: 1, openPriorPeriods: 1,
    }));
    expect(one.map((i) => i.label)).toEqual([
      '1 overdue invoice', '1 overdue supplier bill', '1 prior period still open',
      '1 bill due in 7 days', '1 unreconciled bank transaction', '1 draft invoice', '1 draft journal',
    ]);
    const two = shapeAttention(input({
      counts: { draftInvoices: 2, draftBills: 0, draftJournals: 2, billsDueNext7Days: 2, billsOverdue: 2 },
      overdueInvoices: { count: 2, amount: 10 }, unreconciledBankTxns: 2, openPriorPeriods: 2,
    }));
    expect(two.map((i) => i.label)).toEqual([
      '2 overdue invoices', '2 overdue supplier bills', '2 prior periods still open',
      '2 bills due in 7 days', '2 unreconciled bank transactions', '2 draft invoices', '2 draft journals',
    ]);
    expect(two[0]).toMatchObject({ amount: 10, href: '/accounting/customer-invoices?filter=overdue', severity: 'overdue' });
    expect(two.find((i) => i.key === 'bills-due-7')).toMatchObject({ href: '/accounting/supplier-invoices?due_this_week=1', severity: 'due_soon' });
  });

  it('overdue first, then due soon, then open; dated before undated within one severity', () => {
    const items = shapeAttention(input({
      counts: { draftInvoices: 3, draftBills: 0, draftJournals: 0, billsDueNext7Days: 1, billsOverdue: 0 },
      work: [
        work({ task: 'Undated info', href: '/x/1' }),
        work({ task: 'Late info', href: '/x/2', dueAt: '2026-12-20' }),
        work({ task: 'Early info', href: '/x/3', dueAt: '2026-12-01' }),
        work({ task: 'Overdue thing', href: '/x/4', dueAt: '2026-11-01', severity: 'overdue' }),
      ],
    }));
    expect(items.map((i) => i.severity)).toEqual(['overdue', 'due_soon', 'info', 'info', 'info', 'info']);
    expect(items.map((i) => i.label)).toEqual([
      'Overdue thing', '1 bill due in 7 days', 'Early info', 'Late info', '3 draft invoices', 'Undated info',
    ]);
  });
});
