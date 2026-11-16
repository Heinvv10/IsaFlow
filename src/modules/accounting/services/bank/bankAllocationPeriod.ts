/**
 * WP2 row 12: the fiscal period a bank allocation posts on, resolved BEFORE its journal is written.
 *
 * `createJournalEntry` resolves the covering period itself and, for a date outside the window in which IsaFlow
 * creates one (fiscalPeriodAutoCreate: AUTO_CREATE_YEARS_BACK / _FORWARD), stores fiscal_period_id NULL;
 * `postJournalEntry` skips its closed-period check for a NULL period, so the allocation POSTED outside every
 * period-bounded report (trial balance, VAT201, AFS).
 *
 * The same resolver createJournalEntry uses, not the rule sweep's read-only `getPeriodStatusForDate`: that one says
 * `no_period` for a date whose year IsaFlow would create on the spot (a new company has no periods at all), and
 * refusing those would break the attended allocation that works today. Called last before the journal, after every
 * other refusal, because creating a missing year inside the window is a write.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import {
  AUTO_CREATE_YEARS_BACK, AUTO_CREATE_YEARS_FORWARD, ensureFiscalPeriodForDate, isOutsideWindowByCalendarYear,
} from '../gl/fiscalPeriodAutoCreate';
import { fiscalYearForDate } from '../gl/fiscalYearRegistry';
import { ClosedFiscalPeriodError } from '../gl/journalEntryPostingGuards';
import { BankAllocationRefusal, isBankAllocationRefusal } from './bankAllocationRefusal';

/** Why no period can exist for `entryDate`: a closed or locked fiscal year says so, otherwise the window. */
async function noPeriodRefusal(companyId: string, entryDate: string): Promise<BankAllocationRefusal> {
  if (!isOutsideWindowByCalendarYear(entryDate)) {
    const year = await fiscalYearForDate(companyId, entryDate).catch(() => null);
    if (year && (year.status === 'closed' || year.status === 'locked')) {
      return new BankAllocationRefusal(
        `The fiscal year FY${year.fiscalYear} (${year.startDate} to ${year.endDate}) is ${year.status}, so ${entryDate} `
        + 'cannot be posted to. Re-open the fiscal year first. Nothing was posted.',
      );
    }
  }
  return new BankAllocationRefusal(
    `No fiscal period covers ${entryDate}, and none can be created for it: IsaFlow creates a missing year only from `
    + `${AUTO_CREATE_YEARS_BACK} years back to ${AUTO_CREATE_YEARS_FORWARD} years ahead. Create the period first. `
    + 'Nothing was posted.',
  );
}

/**
 * The OPEN fiscal period covering `entryDate` (created when its year is inside the window), to post the journal on.
 * @throws BankAllocationRefusal (400) when no period covers the date and none can be created.
 * @throws ClosedFiscalPeriodError when the covering period is closed or locked (FiscalPeriodNotGeneratedError, its
 *   subclass, when the year cannot be filled beside closed periods).
 */
export async function allocationPeriodFor(companyId: string, entryDate: string): Promise<string> {
  const periodId = await ensureFiscalPeriodForDate(companyId, entryDate);
  if (!periodId) throw await noPeriodRefusal(companyId, entryDate);
  const rows = (await sql`
    SELECT status FROM fiscal_periods WHERE id = ${periodId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const status = String(rows[0]?.status ?? 'closed');
  if (status !== 'open') throw new ClosedFiscalPeriodError(status);
  return periodId;
}

class ProbeDone extends Error {}

/**
 * Why an allocation dated `entryDate` cannot post (the refusal's own message), or null when it can — asked by the MCP
 * tools BEFORE their write, so a batch skips the line and a single call answers a toolError, and `dry_run` agrees with
 * the live call. It runs `allocationPeriodFor` itself, so the two cannot drift, inside a savepoint that is always
 * rolled back: a year it would create for a postable date is not left behind by a preview.
 */
export async function allocationPeriodProbe(companyId: string, entryDate: string): Promise<string | null> {
  try {
    await withSavepoint('alloc_period_probe', async () => {
      await allocationPeriodFor(companyId, entryDate);
      throw new ProbeDone();
    });
    return null;
  } catch (err) {
    if (err instanceof ProbeDone) return null;
    if (isBankAllocationRefusal(err) || err instanceof ClosedFiscalPeriodError) return err.message;
    throw err;
  }
}

/** The lines among `lines` that cannot post for want of an open fiscal period, with the refusal. One probe per date. */
export async function periodLineSkips(
  companyId: string,
  lines: readonly { txId: string; date: string }[],
): Promise<Map<string, string>> {
  const byDate = new Map<string, string | null>();
  const skips = new Map<string, string>();
  for (const { txId, date } of lines) {
    if (!byDate.has(date)) byDate.set(date, await allocationPeriodProbe(companyId, date));
    const refusal = byDate.get(date);
    if (refusal) skips.set(txId, refusal);
  }
  return skips;
}

/** `allocationPeriodProbe` for one bank line, by id: the date is the line's own. Null when the line is not found. */
export async function lineAllocationPeriodRefusal(companyId: string, bankTxId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT transaction_date FROM bank_transactions WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows[0] ? allocationPeriodProbe(companyId, fmtDate(rows[0].transaction_date as string | Date)) : null;
}
