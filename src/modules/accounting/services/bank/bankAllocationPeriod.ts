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
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  AUTO_CREATE_YEARS_BACK, AUTO_CREATE_YEARS_FORWARD, ensureFiscalPeriodForDate,
} from '../gl/fiscalPeriodAutoCreate';
import { ClosedFiscalPeriodError } from '../gl/journalEntryPostingGuards';
import { BankAllocationRefusal } from './bankAllocationRefusal';

/**
 * The OPEN fiscal period covering `entryDate` (created when its year is inside the window), to post the journal on.
 * @throws BankAllocationRefusal (400) when no period covers the date and none can be created.
 * @throws ClosedFiscalPeriodError when the covering period is closed or locked (FiscalPeriodNotGeneratedError, its
 *   subclass, when the year cannot be filled beside closed periods).
 */
export async function allocationPeriodFor(companyId: string, entryDate: string): Promise<string> {
  const periodId = await ensureFiscalPeriodForDate(companyId, entryDate);
  if (!periodId) {
    throw new BankAllocationRefusal(
      `No fiscal period covers ${entryDate}, and none can be created for it: IsaFlow creates a missing year only from `
      + `${AUTO_CREATE_YEARS_BACK} years back to ${AUTO_CREATE_YEARS_FORWARD} years ahead. Create the period first. `
      + 'Nothing was posted.',
    );
  }
  const rows = (await sql`
    SELECT status FROM fiscal_periods WHERE id = ${periodId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const status = String(rows[0]?.status ?? 'closed');
  if (status !== 'open') throw new ClosedFiscalPeriodError(status);
  return periodId;
}
