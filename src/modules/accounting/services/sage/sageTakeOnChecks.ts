/**
 * Checks of a Sage pull against the IsaFlow company it is going into — the
 * things only the target company can answer. Pure; the store reads the
 * company's side into TakeOnContext.
 *
 *   - Currency: the take-on is home-currency only. A Sage company in another
 *     currency than the IsaFlow company's functional currency blocks.
 *   - Financial year: the opening trial balance is Sage's as at today, so it
 *     carries this year's income and expenses to date. That is only right when
 *     IsaFlow's fiscal year holding the cut-over date (its fiscal_periods)
 *     starts on the day Sage's does; otherwise, or with no period, it blocks.
 *   - Closed periods: the opening balances post on the cut-over date and each
 *     unpaid document on its own date. A date in a closed or locked IsaFlow
 *     period would refuse the whole import at posting time, so each such
 *     period is named up front, with what to do about it.
 */
import type { SagePull } from './sageApiTypes';
import { currencyRule, type CurrencyRule } from './sageCurrency';
import type { TakeOnContext, TakeOnIssue } from './sageTakeOnTypes';

/** The currency symbol Sage shows for each functional currency the take-on supports. */
const HOME_SYMBOLS: Record<string, string> = { ZAR: 'R' };

/** The rule contacts and documents are judged by; refusing the company itself is an issue here. */
export function checkCurrency(pull: SagePull, ctx: TakeOnContext, issues: TakeOnIssue[]): CurrencyRule {
  const rule = (symbol: string) => currencyRule(ctx.homeCurrency || 'ZAR', symbol, pull.currencies);
  const home = HOME_SYMBOLS[ctx.homeCurrency.toUpperCase()];
  if (!home) {
    const books = ctx.homeCurrency ? `keeps its books in ${ctx.homeCurrency}` : 'has no currency set';
    issues.push({ severity: 'error', area: 'company', message: `This IsaFlow company ${books}. Import from Sage supports companies whose currency is ZAR; use the file upload instead.` });
    return rule(pull.company.currencySymbol ?? 'R');
  }
  const sage = pull.company.currencySymbol?.trim();
  if (sage && sage.toLowerCase() !== home.toLowerCase()) {
    issues.push({ severity: 'error', area: 'company', message: `The Sage company "${pull.company.name}" keeps its books in ${sage}, but this IsaFlow company is in ${ctx.homeCurrency}. Choose the matching Sage company, or use the file upload.` });
  }
  return rule(home);
}

export function checkFinancialYear(pull: SagePull, ctx: TakeOnContext, issues: TakeOnIssue[]): void {
  const sage = pull.financialYearStart;
  if (ctx.fiscalYear === null) {
    issues.push({ severity: 'error', area: 'company', message: `IsaFlow has no fiscal period covering ${pull.asAtDate}, the cut-over date, so the opening balances have no year to land in. Create this financial year under Fiscal Periods, starting on ${sage} as Sage's does, then review again.` });
    return;
  }
  if (ctx.fiscalYear.startDate !== sage) {
    issues.push({
      severity: 'error', area: 'company',
      message: `Sage's financial year started on ${sage}, but IsaFlow's fiscal year holding ${pull.asAtDate} runs from ${ctx.fiscalYear.startDate} to ${ctx.fiscalYear.endDate}. The opening balances include this year's income and expenses from ${sage}, which belong in IsaFlow's year only if both start on the same day. Line IsaFlow's fiscal periods up with Sage's year under Fiscal Periods (or correct the year in Sage), then review again.`,
    });
  }
}

/** Every closed or locked IsaFlow period one of `dates` falls in, as one issue per period. */
export function checkClosedPeriods(
  dates: readonly { date: string; what: string }[], ctx: TakeOnContext, issues: TakeOnIssue[],
): void {
  for (const p of ctx.closedPeriods) {
    const hits = dates.filter((d) => d.date >= p.startDate && d.date <= p.endDate);
    if (hits.length === 0) continue;
    const sample = hits.slice(0, 3).map((h) => h.what).join(', ') + (hits.length > 3 ? ` and ${hits.length - 3} more` : '');
    issues.push({
      severity: 'error', area: 'company',
      message: p.status === 'locked'
        ? `IsaFlow period "${p.name}" (${p.startDate} to ${p.endDate}) is locked by a year-end close, and ${hits.length} item(s) from Sage are dated in it (${sample}). A locked period cannot be reopened from the app; ask IsaFlow support before importing.`
        : `IsaFlow period "${p.name}" (${p.startDate} to ${p.endDate}) is closed, and ${hits.length} item(s) from Sage are dated in it (${sample}). Reopen "${p.name}" in IsaFlow under Fiscal periods, review again and import, then close it again.`,
    });
  }
}
