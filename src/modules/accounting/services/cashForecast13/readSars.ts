/**
 * SARS payments for the forecast (ruling 2026-11-16), from the compliance calendar
 * (`getComplianceCalendarWithDB`, due dates already weekend-shifted). An item already completed (e-filed,
 * marked filed or recorded) is left out; one still pending past its due date lands in week 1, flagged.
 *   - EMP201: `generateEMP201(period).totalDeductions` — PAYE net of ETI + UIF + SDL, as the return computes
 *     it. A month after the latest run has nothing to declare yet: the latest run's figures, an estimate.
 *   - VAT201: readVat.ts.
 *   - IRP6: the primary budget's IRP6 event in the calendar item's due month; none → no line, flagged.
 * Each amount is read in its own savepoint: one unreadable return leaves the others.
 */
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getComplianceCalendarWithDB } from '@/modules/accounting/services/reports/sarsComplianceCalendarDb';
import type { ComplianceEvent } from '@/modules/accounting/services/reports/sarsTaxPeriodsService';
import { guardedSource } from './guardedSource';
import { toCents } from './lines';
import { vatItem } from './readVat';
import type { BudgetRead } from './readBudget';
import type { PayrollRead } from './readPayroll';
import type { ForecastWarning, KnownItem } from './types';

const PAYABLE = new Set(['EMP201_DUE', 'VAT201_DUE', 'PROVISIONAL_TAX']);

/** Pending calendar items due by the horizon end. The calendar of year y runs to 31 Mar y+1, so y+1 is read too when the horizon passes it. */
export async function readSarsEvents(companyId: string, today: string, horizonEnd: string): Promise<ComplianceEvent[]> {
  const y = Number(today.slice(0, 4));
  const years = horizonEnd > `${y + 1}-03-31` ? [y, y + 1] : [y];
  const byKey = new Map<string, ComplianceEvent>();
  for (const year of years) {
    for (const e of await getComplianceCalendarWithDB(companyId, year)) byKey.set(`${e.eventType}|${e.periodStart}|${e.periodEnd}`, e);
  }
  return [...byKey.values()]
    .filter((e) => PAYABLE.has(e.eventType) && e.status !== 'completed' && e.dueDate <= horizonEnd)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.eventType < b.eventType ? -1 : 1));
}

async function emp201Item(companyId: string, e: ComplianceEvent, today: string, payroll: PayrollRead): Promise<KnownItem | null> {
  const latest = payroll.latest;
  if (!latest) return null;
  const afterLatest = e.periodStart.slice(0, 7) > latest.period;
  const amount = afterLatest ? latest.statutoryCents : toCents((await generateEMP201(companyId, e.periodStart, e.periodEnd)).totalDeductions);
  if (amount <= 0) return null;
  return {
    lineKey: 'sars:emp201', lineLabel: 'SARS EMP201 (PAYE, UIF, SDL)', category: 'sars', date: e.dueDate, amountCents: -amount,
    ref: `EMP201:${e.periodStart}`, refLabel: e.description, estimate: afterLatest,
    flags: [...(afterLatest ? ['estimated_from_latest_run'] : []), ...(e.dueDate < today ? ['overdue_unfiled'] : [])],
  };
}

function irp6Item(e: ComplianceEvent, today: string, budget: BudgetRead | null, warnings: ForecastWarning[]): KnownItem | null {
  const event = budget?.taxEvents.find((t) => (t.kind === 'irp6_first' || t.kind === 'irp6_second') && t.month === e.dueDate.slice(0, 7));
  if (!event || event.amount <= 0) {
    warnings.push({ code: 'irp6_no_budget', source: 'irp6', message: `${e.description}: no IRP6 payment in a primary budget for ${e.dueDate.slice(0, 7)}; no line` });
    return null;
  }
  return {
    lineKey: 'sars:irp6', lineLabel: 'SARS provisional tax (IRP6)', category: 'sars', date: e.dueDate, amountCents: -event.amount,
    ref: `IRP6:${e.dueDate}`, refLabel: e.description, estimate: true, flags: e.dueDate < today ? ['overdue_unfiled'] : [],
  };
}

export async function sarsItems(
  companyId: string, today: string, horizonEnd: string, payroll: PayrollRead | null, budget: BudgetRead | null, warnings: ForecastWarning[],
): Promise<KnownItem[]> {
  const items: KnownItem[] = [];
  for (const e of await readSarsEvents(companyId, today, horizonEnd)) {
    let item: KnownItem | null = null;
    if (e.eventType === 'EMP201_DUE') {
      if (payroll) item = await guardedSource('cash13_emp201', `EMP201 ${e.periodStart.slice(0, 7)}`, warnings, () => emp201Item(companyId, e, today, payroll));
    } else if (e.eventType === 'VAT201_DUE') {
      item = await guardedSource('cash13_vat201', `VAT201 ${e.periodStart}..${e.periodEnd}`, warnings, () => vatItem(companyId, e, today, budget, warnings));
    } else {
      item = irp6Item(e, today, budget, warnings);
    }
    if (item) items.push(item);
  }
  const overdue = items.filter((i) => i.flags?.includes('overdue_unfiled')).length;
  if (overdue > 0) {
    warnings.push({ code: 'sars_overdue_unfiled', source: 'sars', message: `${overdue} SARS payment(s) past due and not marked filed are in week 1` });
  }
  return items;
}
