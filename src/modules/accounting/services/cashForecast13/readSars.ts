/**
 * SARS payments for the forecast (rulings 2026-11-16, review H1), from the compliance calendar
 * (`getComplianceCalendarWithMarks`, due dates already weekend-shifted). An item already completed (e-filed,
 * marked filed or recorded) is left out.
 *
 * PAST DUE = ASSUMED PAID (H1). A payment whose due date is before today is not forecast: its cash has left
 * the bank and is in opening cash, and an unmarked January–October EMP201 is far more often "paid, never
 * marked" than "owed". A REFUND is judged by its arrival date instead (re-review L-d): one arriving today or
 * later is forecast even when the return's due date has passed. Each assumed one is listed in the
 * `sars_past_due_assumed_paid` warning (type, period, amount) so the user can see what was assumed.
 *   - EMP201: `generateEMP201(period).totalDeductions` — PAYE net of ETI + UIF + SDL, as the return computes
 *     it. A month after the latest run has nothing to declare yet: the latest run's figures, an estimate.
 *   - VAT201: readVat.ts.
 *   - IRP6: the primary budget's IRP6 event in the calendar item's due month; none → no line, flagged.
 * When the calendar could not read the marks or the filings, a filed item may show as pending: said in a
 * warning, never silently. Each amount is read in its own savepoint: one unreadable return leaves the others.
 */
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getComplianceCalendarWithMarks } from '@/modules/accounting/services/reports/sarsComplianceCalendarDb';
import type { ComplianceEvent } from '@/modules/accounting/services/reports/sarsTaxPeriodsService';
import { guardedSource } from './guardedSource';
import { toCents } from './lines';
import { vatItem } from './readVat';
import type { BudgetRead } from './readBudget';
import type { PayrollRead } from './readPayroll';
import type { ForecastWarning, KnownItem } from './types';

const PAYABLE = new Set(['EMP201_DUE', 'VAT201_DUE', 'PROVISIONAL_TAX']);

/** Pending calendar items due by the horizon end. The calendar of year y runs to 31 Mar y+1, so y+1 is read too when the horizon passes it. */
export async function readSarsEvents(companyId: string, today: string, horizonEnd: string, warnings: ForecastWarning[]): Promise<ComplianceEvent[]> {
  const y = Number(today.slice(0, 4));
  const years = horizonEnd > `${y + 1}-03-31` ? [y, y + 1] : [y];
  const byKey = new Map<string, ComplianceEvent>();
  let marks = false;
  let filings = false;
  for (const year of years) {
    const cal = await getComplianceCalendarWithMarks(companyId, year);
    marks ||= cal.marksUnavailable;
    filings ||= cal.submissionsUnavailable;
    for (const e of cal.events) byKey.set(`${e.eventType}|${e.periodStart}|${e.periodEnd}`, e);
  }
  if (marks) warnings.push({ code: 'sars_marks_unavailable', source: 'sars', message: 'The SARS items marked filed could not be read: a filed return may be forecast as a payment' });
  if (filings) warnings.push({ code: 'sars_submissions_unavailable', source: 'sars', message: 'The SARS filings could not be read: a filed return may be forecast as a payment' });
  return [...byKey.values()]
    .filter((e) => PAYABLE.has(e.eventType) && e.status !== 'completed' && e.dueDate <= horizonEnd)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.eventType < b.eventType ? -1 : 1));
}

export async function emp201Item(companyId: string, e: ComplianceEvent, payroll: PayrollRead): Promise<KnownItem | null> {
  const latest = payroll.latest;
  if (!latest) return null;
  const afterLatest = e.periodStart.slice(0, 7) > latest.period;
  const amount = afterLatest ? latest.statutoryCents : toCents((await generateEMP201(companyId, e.periodStart, e.periodEnd)).totalDeductions);
  if (amount <= 0) return null;
  return {
    lineKey: 'sars:emp201', lineLabel: 'SARS EMP201 (PAYE, UIF, SDL)', category: 'sars', date: e.dueDate, amountCents: -amount,
    ref: `EMP201:${e.periodStart}`, refLabel: e.description, estimate: afterLatest,
    flags: afterLatest ? ['estimated_from_latest_run'] : [],
  };
}

/** The IRP6 payment from the primary budget in the item's due month, or null (warned) when the budget has none. */
export function irp6Item(e: ComplianceEvent, budget: BudgetRead | null, warnings: ForecastWarning[]): KnownItem | null {
  const event = budget?.taxEvents.find((t) => (t.kind === 'irp6_first' || t.kind === 'irp6_second') && t.month === e.dueDate.slice(0, 7));
  if (!event || event.amount <= 0) {
    warnings.push({ code: 'irp6_no_budget', source: 'irp6', message: `${e.description}: no IRP6 payment in a primary budget for ${e.dueDate.slice(0, 7)}; no line` });
    return null;
  }
  return {
    lineKey: 'sars:irp6', lineLabel: 'SARS provisional tax (IRP6)', category: 'sars', date: e.dueDate, amountCents: -event.amount,
    ref: `IRP6:${e.dueDate}`, refLabel: e.description, estimate: true,
  };
}

const KIND: Record<string, string> = { EMP201_DUE: 'EMP201', VAT201_DUE: 'VAT201', PROVISIONAL_TAX: 'IRP6' };
const rand = (cents: number) => `R${(Math.abs(cents) / 100).toFixed(2)}${cents > 0 ? ' refund' : ''}`;

export async function sarsItems(
  companyId: string, today: string, horizonEnd: string, payroll: PayrollRead | null, budget: BudgetRead | null, warnings: ForecastWarning[],
): Promise<KnownItem[]> {
  const items: KnownItem[] = [];
  const assumedPaid: string[] = [];
  for (const e of await readSarsEvents(companyId, today, horizonEnd, warnings)) {
    const own: ForecastWarning[] = [];
    let item: KnownItem | null = null;
    if (e.eventType === 'EMP201_DUE') {
      if (payroll) item = await guardedSource('cash13_emp201', `EMP201 ${e.periodStart.slice(0, 7)}`, own, () => emp201Item(companyId, e, payroll));
    } else if (e.eventType === 'VAT201_DUE') {
      item = await guardedSource('cash13_vat201', `VAT201 ${e.periodStart}..${e.periodEnd}`, own, () => vatItem(companyId, e, today, budget, own));
    } else {
      item = irp6Item(e, budget, own);
    }
    // A payment is assumed paid when its DUE date has passed; a refund when its ARRIVAL date has (re-review L-d).
    const past = item !== null && item.amountCents > 0 ? item.date < today : e.dueDate < today;
    if (!past) {
      warnings.push(...own);
      if (item) items.push(item);
    } else if (item) {
      assumedPaid.push(`${KIND[e.eventType]} ${e.periodStart}..${e.periodEnd} due ${e.dueDate} ${rand(item.amountCents)}`);
    }
  }
  if (assumedPaid.length > 0) {
    warnings.push({
      code: 'sars_past_due_assumed_paid', source: 'sars',
      message: `${assumedPaid.length} SARS item(s) due before today and not marked filed are assumed paid (in opening cash): ${assumedPaid.join('; ')}`,
    });
  }
  return items;
}
