import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComplianceEvent } from '@/modules/accounting/services/reports/sarsTaxPeriodsService';

const calendar = vi.fn();
const vat201 = vi.fn();
const emp201 = vi.fn();
vi.mock('@/lib/neon', () => ({ withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/sarsComplianceCalendarDb', () => ({ getComplianceCalendarWithMarks: (...a: unknown[]) => calendar(...a) }));
vi.mock('@/modules/accounting/services/reports/vat201Return', () => ({ getVat201Return: (...a: unknown[]) => vat201(...a) }));
vi.mock('@/modules/accounting/services/reports/emp201Service', () => ({ generateEMP201: (...a: unknown[]) => emp201(...a) }));

import { sarsItems } from '@/modules/accounting/services/cashForecast13/readSars';
import { budgetRemainder, vatItem, vatRefundDate } from '@/modules/accounting/services/cashForecast13/readVat';
import type { BudgetRead } from '@/modules/accounting/services/cashForecast13/readBudget';
import type { PayrollRead } from '@/modules/accounting/services/cashForecast13/readPayroll';
import type { ForecastWarning } from '@/modules/accounting/services/cashForecast13/types';

const TODAY = '2026-11-18';
const END = '2027-02-14';
const ev = (over: Partial<ComplianceEvent>): ComplianceEvent => ({
  eventType: 'EMP201_DUE', dueDate: '2026-12-07', periodStart: '2026-11-01', periodEnd: '2026-11-30', description: 'EMP201 Nov', status: 'pending', ...over,
});
const payroll: PayrollRead = { latest: { id: 'r', period: '2026-10', netCents: 900_000, statutoryCents: 180_000 }, runs: [], unsupportedFrequency: false };
const budget = (over: Partial<BudgetRead> = {}): BudgetRead => ({ months: [], vatSettlements: [], taxEvents: [], refundLagMonths: 1, ...over });
const cal = (events: ComplianceEvent[], flags: { marksUnavailable?: boolean; submissionsUnavailable?: boolean } = {}) =>
  calendar.mockResolvedValue({ events, marksUnavailable: false, submissionsUnavailable: false, ...flags });

beforeEach(() => { calendar.mockReset(); vat201.mockReset(); emp201.mockReset(); });

describe('cash13 SARS: past due is assumed paid (review H1)', () => {
  it('forecasts only items due today or later; lists every earlier one in sars_past_due_assumed_paid with its amount', async () => {
    cal([
      ev({ dueDate: '2026-10-07', periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
      ev({ dueDate: TODAY, periodStart: '2026-10-01', periodEnd: '2026-10-31' }),
      ev({}),
    ]);
    emp201.mockResolvedValue({ totalDeductions: 1_234.5 });
    const warnings: ForecastWarning[] = [];
    const items = await sarsItems('co', TODAY, END, payroll, null, warnings);
    expect(items.map((i) => [i.ref, i.date, i.amountCents])).toEqual([
      ['EMP201:2026-10-01', TODAY, -123_450],
      ['EMP201:2026-11-01', '2026-12-07', -180_000],
    ]);
    const w = warnings.find((x) => x.code === 'sars_past_due_assumed_paid')!;
    expect(w.message).toContain('EMP201 2026-09-01..2026-09-30 due 2026-10-07 R1234.50');
  });

  it('a completed item is neither forecast nor listed as assumed paid', async () => {
    cal([ev({ status: 'completed' }), ev({ dueDate: '2026-10-07', periodStart: '2026-09-01', periodEnd: '2026-09-30', status: 'completed' })]);
    const warnings: ForecastWarning[] = [];
    expect(await sarsItems('co', TODAY, END, payroll, null, warnings)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('says so when the calendar could not read the marks or the filings', async () => {
    cal([], { marksUnavailable: true, submissionsUnavailable: true });
    const warnings: ForecastWarning[] = [];
    await sarsItems('co', TODAY, END, payroll, null, warnings);
    expect(warnings.map((w) => w.code).sort()).toEqual(['sars_marks_unavailable', 'sars_submissions_unavailable']);
  });

  it('EMP201 after the latest run is the run’s statutory figure, flagged an estimate; up to the latest run it is the declaration', async () => {
    cal([ev({}), ev({ dueDate: '2026-11-20', periodStart: '2026-10-01', periodEnd: '2026-10-31' })]);
    emp201.mockResolvedValue({ totalDeductions: 1_500 });
    const items = await sarsItems('co', TODAY, END, payroll, null, []);
    expect(items.find((i) => i.ref === 'EMP201:2026-10-01')).toMatchObject({ amountCents: -150_000, estimate: false });
    expect(items.find((i) => i.ref === 'EMP201:2026-11-01')).toMatchObject({ amountCents: -180_000, estimate: true, flags: ['estimated_from_latest_run'] });
    expect(emp201).toHaveBeenCalledTimes(1);
  });

  it('IRP6 only from a budget event in the due month; otherwise no line and irp6_no_budget', async () => {
    const irp6 = ev({ eventType: 'PROVISIONAL_TAX', dueDate: '2027-02-26', periodStart: '2026-03-01', periodEnd: '2027-02-28', description: 'IRP6 second' });
    cal([irp6]);
    const hit = await sarsItems('co', '2027-02-01', '2027-04-30', null,
      budget({ taxEvents: [{ month: '2027-01', kind: 'irp6_second', amount: 1 }, { month: '2027-02', kind: 'irp6_second', amount: 7_000 }] }), []);
    expect(hit).toEqual([expect.objectContaining({ lineKey: 'sars:irp6', amountCents: -7_000, date: '2027-02-26' })]);
    const warnings: ForecastWarning[] = [];
    expect(await sarsItems('co', '2027-02-01', '2027-04-30', null, budget({ taxEvents: [{ month: '2027-02', kind: 'top_up', amount: 9 }] }), warnings)).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(['irp6_no_budget']);
  });
});

describe('cash13 SARS refunds: assumed received by ARRIVAL date (re-review L-d)', () => {
  const vatEv = (over: Partial<ComplianceEvent>) => ev({ eventType: 'VAT201_DUE', description: 'VAT', ...over });

  it('a refund due before today but arriving today or later is forecast; one that already arrived is assumed received', async () => {
    cal([
      vatEv({ periodStart: '2026-09-01', periodEnd: '2026-10-31', dueDate: '2026-11-06' }), // refund arrives 2026-11-30
      vatEv({ periodStart: '2026-07-01', periodEnd: '2026-08-31', dueDate: '2026-09-25' }), // refund arrived 2026-09-30
    ]);
    vat201.mockResolvedValue({ field11_vatPayableOrRefundable: -800 });
    const warnings: ForecastWarning[] = [];
    const items = await sarsItems('co', TODAY, END, null, budget(), warnings);
    expect(items.map((i) => [i.ref, i.date, i.amountCents])).toEqual([['VAT201:2026-09-01:2026-10-31', '2026-11-30', 80_000]]);
    expect(warnings.find((w) => w.code === 'sars_past_due_assumed_paid')?.message).toContain('VAT201 2026-07-01..2026-08-31');
  });

  it('a VAT201 whose read FAILS is never judged past by its due date: no line, and the source_unavailable warning is kept', async () => {
    // Reviewer case: period ending 30 Sep, due 23 Oct, lag 3 — a refund would arrive 31 Dec; the read raises a SQLSTATE.
    cal([vatEv({ periodStart: '2026-08-01', periodEnd: '2026-09-30', dueDate: '2026-10-23' })]);
    vat201.mockRejectedValue(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    const warnings: ForecastWarning[] = [];
    expect(await sarsItems('co', TODAY, END, null, budget({ refundLagMonths: 3 }), warnings)).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ code: 'source_unavailable', source: 'VAT201 2026-08-01..2026-09-30' })]);
  });

  it('a payable keeps the due-date rule', async () => {
    cal([vatEv({ periodStart: '2026-09-01', periodEnd: '2026-10-31', dueDate: '2026-11-06' })]);
    vat201.mockResolvedValue({ field11_vatPayableOrRefundable: 800 });
    expect(await sarsItems('co', TODAY, END, null, budget(), [])).toEqual([]);
  });
});

describe('cash13 VAT201', () => {
  const vatEv = (over: Partial<ComplianceEvent>) => ev({ eventType: 'VAT201_DUE', description: 'VAT', ...over });

  it('a closed period payable is an outflow on the due date', async () => {
    vat201.mockResolvedValue({ field11_vatPayableOrRefundable: 2_500 });
    const item = await vatItem('co', vatEv({ periodStart: '2026-09-01', periodEnd: '2026-10-31', dueDate: '2026-11-25' }), TODAY, null, []);
    expect(item).toMatchObject({ date: '2026-11-25', amountCents: -250_000, estimate: false });
  });

  it('a closed period refund is an INFLOW, dated the last day of period end + lag months', async () => {
    vat201.mockResolvedValue({ field11_vatPayableOrRefundable: -800 });
    const item = await vatItem('co', vatEv({ periodStart: '2026-09-01', periodEnd: '2026-10-31', dueDate: '2026-11-25' }), TODAY, budget({ refundLagMonths: 2 }), []);
    expect(item).toMatchObject({ date: '2026-12-31', amountCents: 80_000 });
    expect(vatRefundDate('2026-10-31', 1)).toBe('2026-11-30');
    expect(vatRefundDate('2026-12-31', 2)).toBe('2027-02-28');
    expect(vatRefundDate('2026-10-31', 0)).toBe('2026-10-31');
  });

  it('the open period: accrued to today plus the budget pro rata to the days left', async () => {
    vat201.mockResolvedValue({ field11_vatPayableOrRefundable: 100 });
    const e = vatEv({ periodStart: '2026-11-01', periodEnd: '2026-12-31', dueDate: '2027-01-25' });
    const b = budget({ vatSettlements: [{ periodStart: '2026-11', periodEnd: '2026-12', net: 61_000, settleMonth: '2027-01', settled: true }] });
    // 61 days in the period, 43 after today (Nov 19..Dec 31): 61000 × 43/61 = 43000.
    expect(budgetRemainder(e, b.vatSettlements[0]!, TODAY)).toBe(43_000);
    expect(await vatItem('co', e, TODAY, b, [])).toMatchObject({ amountCents: -(10_000 + 43_000), estimate: true });
    expect(vat201).toHaveBeenCalledWith('co', '2026-11-01', TODAY);
  });

  it('no budget: the open period is accrued only, flagged; a future period has no line; both warn', async () => {
    vat201.mockResolvedValue({ field11_vatPayableOrRefundable: 100 });
    const warnings: ForecastWarning[] = [];
    expect(await vatItem('co', vatEv({ periodStart: '2026-11-01', periodEnd: '2026-12-31', dueDate: '2027-01-25' }), TODAY, null, warnings))
      .toMatchObject({ amountCents: -10_000, flags: ['vat_no_budget'] });
    expect(await vatItem('co', vatEv({ periodStart: '2027-01-01', periodEnd: '2027-02-28', dueDate: '2027-03-25' }), TODAY, null, warnings)).toBeNull();
    expect(warnings.map((w) => w.code)).toEqual(['vat_no_budget', 'vat_no_budget']);
  });

  it('a future period with a budget is the whole settlement', async () => {
    const e = vatEv({ periodStart: '2027-01-01', periodEnd: '2027-02-28', dueDate: '2027-03-25' });
    const s = { periodStart: '2027-01', periodEnd: '2027-02', net: -5_000, settleMonth: '2027-03', settled: true };
    expect(budgetRemainder(e, s, TODAY)).toBe(-5_000);
    expect(await vatItem('co', e, TODAY, budget({ vatSettlements: [s] }), [])).toMatchObject({ amountCents: 5_000, date: '2027-03-31' });
    expect(vat201).not.toHaveBeenCalled();
  });
});
