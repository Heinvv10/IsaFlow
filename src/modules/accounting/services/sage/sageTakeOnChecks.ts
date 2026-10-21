/**
 * Checks of a Sage pull against the IsaFlow company it is going into — the
 * things only the target company can answer. Pure; the store reads the
 * company's side into TakeOnContext.
 *
 *   - Currency: the take-on is home-currency only. A Sage company in another
 *     currency than the IsaFlow company's functional currency blocks.
 *   - Financial year: the opening trial balance is Sage's as at today, so it
 *     carries this year's income and expenses to date. That is only right when
 *     Sage's year and IsaFlow's start in the same month; otherwise it blocks.
 *   - Closed periods: the opening balances post on the cut-over date and each
 *     unpaid document on its own date. A date in a closed or locked IsaFlow
 *     period would refuse the whole import at posting time, so each such
 *     period is named up front, with what to do about it.
 */
import type { SagePull } from './sageApiTypes';
import type { TakeOnContext, TakeOnIssue } from './sageTakeOnTypes';

/** The currency symbol Sage shows for each functional currency the take-on supports. */
const HOME_SYMBOLS: Record<string, string> = { ZAR: 'R' };

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The symbol contacts and documents are compared with; null when the company itself is refused. */
export function checkCurrency(pull: SagePull, ctx: TakeOnContext, issues: TakeOnIssue[]): string | null {
  const home = HOME_SYMBOLS[ctx.homeCurrency.toUpperCase()];
  if (!home) {
    const books = ctx.homeCurrency ? `keeps its books in ${ctx.homeCurrency}` : 'has no currency set';
    issues.push({ severity: 'error', area: 'company', message: `This IsaFlow company ${books}. Import from Sage supports companies whose currency is ZAR; use the file upload instead.` });
    return null;
  }
  const sage = pull.company.currencySymbol?.trim();
  if (sage && sage.toLowerCase() !== home.toLowerCase()) {
    issues.push({ severity: 'error', area: 'company', message: `The Sage company "${pull.company.name}" keeps its books in ${sage}, but this IsaFlow company is in ${ctx.homeCurrency}. Choose the matching Sage company, or use the file upload.` });
    return null;
  }
  return home;
}

export function checkFinancialYear(pull: SagePull, ctx: TakeOnContext, issues: TakeOnIssue[]): void {
  const sageMonth = Number(pull.financialYearStart.slice(5, 7));
  if (ctx.fiscalYearStartMonth === null) {
    issues.push({ severity: 'error', area: 'company', message: `This IsaFlow company has no financial year start set. Set it in Company settings (Sage's year starts in ${MONTH_NAMES[sageMonth - 1] ?? pull.financialYearStart}), then review again.` });
    return;
  }
  if (sageMonth !== ctx.fiscalYearStartMonth) {
    issues.push({
      severity: 'error', area: 'company',
      message: `Sage's financial year starts in ${MONTH_NAMES[sageMonth - 1] ?? pull.financialYearStart} but this IsaFlow company's starts in ${MONTH_NAMES[ctx.fiscalYearStartMonth - 1]}. The opening balances include this year's income and expenses to date, which only belong in IsaFlow's year if both start in the same month. Correct the financial year in IsaFlow's Company settings (or in Sage), then review again.`,
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
