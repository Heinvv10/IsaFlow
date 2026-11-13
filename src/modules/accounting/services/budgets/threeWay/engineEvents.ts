/**
 * Dated events of one engine run, bucketed by month before the month loop:
 * capex, loan drawdowns and principal, share issues, dividends, provisional
 * tax. Also the 10c checks (asset register depreciation, loan-schedule
 * interest vs the P&L — warnings when > 5 % apart, never overrides).
 *
 * Entries dated outside the version's months are skipped and warned (§13.20),
 * each warning saying exactly what was skipped: a dividend declared before the
 * version is skipped whole (its payable is in the opening); one declared inside
 * and paid after stays payable; a planned loan drawn outside is excluded whole.
 */
import type { ThreeWayAssumptions } from './assumptionsSchema';
import { vatOnNet } from './ratios';
import type { EngineRates } from './engineInput';
import { addMonths } from './months';
import { provisionalTaxApplies, provisionalTaxSchedule, sarsTopUpOffset } from './statutorySchedule';
import type { EngineInput, OutsideMonthsEntry, TaxEvent, ThreeWayWarning } from './types';

export interface MonthEvents {
  capex: Array<{ exVat: number; vat: number }>;
  drawdowns: number[];
  principal: number;
  shareIssues: number[];
  dividendsDeclared: number[];
  dividendsPaid: number[];
  tax: TaxEvent[];
}

export interface PlannedEvents {
  byMonth: Map<string, MonthEvents>;
  taxEvents: TaxEvent[];
  warnings: ThreeWayWarning[];
}

function emptyEvents(): MonthEvents {
  return { capex: [], drawdowns: [], principal: 0, shareIssues: [], dividendsDeclared: [], dividendsPaid: [], tax: [] };
}

/** True when check and budget differ by more than 5 % of the budgeted figure (exact, BigInt). */
export function differsByMoreThan5Pct(budgeted: number, check: number): boolean {
  const diff = BigInt(Math.abs(check - budgeted));
  return diff * 20n > BigInt(Math.abs(budgeted));
}

function outsideEntries(a: ThreeWayAssumptions, inside: (m: string) => boolean, first: string, last: string): OutsideMonthsEntry[] {
  const span = `${first}..${last}`;
  const out: OutsideMonthsEntry[] = [];
  for (const c of a.capex) {
    if (!inside(c.month)) out.push({ list: 'capex', id: c.id, skipped: 'entry', detail: `capex ${c.id} dated ${c.month}, outside ${span}: skipped` });
  }
  for (const l of a.loans.planned) {
    if (!inside(l.drawdownMonth)) {
      out.push({ list: 'loans.planned', id: l.id, skipped: 'entry', detail: `planned loan ${l.id} drawn ${l.drawdownMonth}, outside ${span}: skipped with its repayments` });
    }
  }
  for (const x of a.equity.shareIssues) {
    if (!inside(x.month)) out.push({ list: 'equity.shareIssues', id: x.id, skipped: 'entry', detail: `share issue ${x.id} dated ${x.month}, outside ${span}: skipped` });
  }
  for (const d of a.equity.dividends) {
    if (d.declaredMonth < first) {
      out.push({ list: 'equity.dividends', id: d.id, skipped: 'entry',
        detail: `dividend ${d.id} declared ${d.declaredMonth}, before ${span}: skipped, and so is its payment in ${d.paidMonth} (a dividend declared before the version is in the opening dividends payable)` });
    } else if (d.declaredMonth > last) {
      out.push({ list: 'equity.dividends', id: d.id, skipped: 'entry', detail: `dividend ${d.id} declared ${d.declaredMonth}, after ${span}: skipped` });
    } else if (!inside(d.paidMonth)) {
      out.push({ list: 'equity.dividends', id: d.id, skipped: 'payment', detail: `dividend ${d.id} paid ${d.paidMonth}, after ${last}: payment skipped, the declaration stays payable` });
    }
  }
  return out;
}

/** §13.1: a derived offset is the SARS rule from the prior year end; a manual one is honoured and warned when it differs. */
function topUpOffset(a: ThreeWayAssumptions, priorYearEnd: string, warnings: ThreeWayWarning[]): 6 | 7 {
  const sars = sarsTopUpOffset(priorYearEnd);
  const stored = a.incomeTax.topUpMonthOffset;
  if (stored.source === 'derived') return sars;
  if (stored.value !== sars) warnings.push({ code: 'top_up_offset_not_sars', value: stored.value, sars });
  return stored.value;
}

export function planEvents(input: EngineInput, a: ThreeWayAssumptions, rates: EngineRates): PlannedEvents {
  const months = input.months;
  const first = months[0] as string;
  const last = months[months.length - 1] as string;
  const byMonth = new Map<string, MonthEvents>(months.map(m => [m, emptyEvents()]));
  const inside = (m: string) => byMonth.has(m);
  const warnings: ThreeWayWarning[] = [];
  const outside = outsideEntries(a, inside, first, last);
  if (outside.length > 0) warnings.push({ code: 'outside_months', entries: outside });

  for (const c of a.capex) {
    const vat = c.vatClaimable ? vatOnNet(c.amountExVat, rates.capexSharePpm) : 0;
    byMonth.get(c.month)?.capex.push({ exVat: c.amountExVat, vat });
  }
  // A planned loan drawn outside the version is excluded whole (drawdown and repayments).
  const plannedInside = a.loans.planned.filter(l => inside(l.drawdownMonth));
  for (const l of plannedInside) byMonth.get(l.drawdownMonth)?.drawdowns.push(l.principal);
  for (const x of a.equity.shareIssues) byMonth.get(x.month)?.shareIssues.push(x.amount);
  for (const d of a.equity.dividends) {
    if (!inside(d.declaredMonth)) continue;
    byMonth.get(d.declaredMonth)?.dividendsDeclared.push(d.amount);
    byMonth.get(d.paidMonth)?.dividendsPaid.push(d.amount);
  }

  // Loans: included existing loans and every planned loan drawn inside repay per their schedules.
  const included = [...a.loans.existing.filter(l => l.include).map(l => l.loanId), ...plannedInside.map(l => l.id)];
  const schedules = new Map(input.loanSchedules.map(s => [s.loanId, s]));
  const missing = included.filter(id => !schedules.has(id));
  if (missing.length > 0) warnings.push({ code: 'loan_schedule_missing', loanIds: missing });
  let scheduleInterest = 0;
  let anySchedule = false;
  for (const id of included) {
    const s = schedules.get(id);
    if (!s) continue;
    anySchedule = true;
    for (const line of s.lines) {
      const ev = byMonth.get(line.month);
      if (!ev) continue;
      ev.principal += line.principal;
      scheduleInterest += line.interest;
    }
  }

  // Provisional tax (10b, §13.1–3).
  let taxEvents: TaxEvent[] = [];
  if (a.incomeTax.mode.value === 'provisional') {
    if (provisionalTaxApplies(input.entityType)) {
      taxEvents = provisionalTaxSchedule({
        months,
        taxExpense: input.pnl.map(p => p.taxExpense),
        openingTaxPayable: -input.opening.buckets.incomeTaxPayable,
        topUpOffset: topUpOffset(a, addMonths(first, -1), warnings),
      });
      for (const e of taxEvents) byMonth.get(e.month)?.tax.push(e);
    } else {
      warnings.push({ code: 'provisional_tax_not_applicable', entityType: input.entityType });
    }
  }

  // 10c checks.
  const dep = input.checks?.assetRegisterDepreciation;
  if (dep) {
    const budgeted = input.pnl.reduce((s, p) => s + p.depreciation, 0);
    const check = dep.reduce((s, v) => s + v, 0);
    if (differsByMoreThan5Pct(budgeted, check)) warnings.push({ code: 'depreciation_check', budgeted, check });
  }
  if (anySchedule) {
    const budgeted = input.pnl.reduce((s, p) => s + p.financeCost, 0);
    if (differsByMoreThan5Pct(budgeted, scheduleInterest)) warnings.push({ code: 'interest_check', budgeted, check: scheduleInterest });
  }
  return { byMonth, taxEvents, warnings };
}
