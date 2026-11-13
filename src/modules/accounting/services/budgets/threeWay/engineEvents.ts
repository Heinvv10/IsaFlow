/**
 * Dated events of one engine run, bucketed by month before the month loop:
 * capex, loan drawdowns and principal, share issues, dividends, provisional
 * tax. Also the 10c checks (asset register depreciation, loan-schedule
 * interest vs the P&L — warnings when > 5 % apart, never overrides).
 *
 * Entries dated outside the version's months are skipped and warned (§13.20);
 * a dividend declared inside and paid after the version stays payable.
 */
import type { ThreeWayAssumptions } from './assumptionsSchema';
import { vatOnNet } from './ratios';
import type { EngineRates } from './engineInput';
import { provisionalTaxApplies, provisionalTaxSchedule } from './statutorySchedule';
import type { EngineInput, OutsideMonthsList, TaxEvent, ThreeWayWarning } from './types';

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

export function planEvents(input: EngineInput, a: ThreeWayAssumptions, rates: EngineRates): PlannedEvents {
  const months = input.months;
  const byMonth = new Map<string, MonthEvents>(months.map(m => [m, emptyEvents()]));
  const warnings: ThreeWayWarning[] = [];
  const outside: Array<{ list: OutsideMonthsList; id: string }> = [];
  const at = (month: string, list: OutsideMonthsList, id: string): MonthEvents | null => {
    const ev = byMonth.get(month);
    if (!ev && !outside.some(o => o.list === list && o.id === id)) outside.push({ list, id });
    return ev ?? null;
  };

  for (const c of a.capex) {
    const vat = c.vatClaimable ? vatOnNet(c.amountExVat, rates.capexSharePpm) : 0;
    at(c.month, 'capex', c.id)?.capex.push({ exVat: c.amountExVat, vat });
  }
  for (const l of a.loans.planned) at(l.drawdownMonth, 'loans.planned', l.id)?.drawdowns.push(l.principal);
  for (const s of a.equity.shareIssues) at(s.month, 'equity.shareIssues', s.id)?.shareIssues.push(s.amount);
  for (const d of a.equity.dividends) {
    at(d.declaredMonth, 'equity.dividends', d.id)?.dividendsDeclared.push(d.amount);
    at(d.paidMonth, 'equity.dividends', d.id)?.dividendsPaid.push(d.amount);
  }
  if (outside.length > 0) warnings.push({ code: 'outside_months', entries: outside });

  // Loans: included existing loans and every planned loan repay per their schedules.
  const included = [...new Set([...a.loans.existing.filter(l => l.include).map(l => l.loanId), ...a.loans.planned.map(l => l.id)])];
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
        topUpOffset: a.incomeTax.topUpMonthOffset.value,
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
