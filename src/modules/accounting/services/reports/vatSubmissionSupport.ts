/** vatSubmissionService helpers: the net-VAT account, the clearing date and its fiscal-period guard. */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { getFiscalPeriodIdForDate } from '../gl/fiscalPeriodService';
import { isAutoCreatableYear } from '../gl/fiscalPeriodAutoCreate';

/**
 * Resolve the "net VAT" clearing account.
 * Prefers account_code 2130 (Accrued Expenses) — which has no system subtype in the
 * default IsaFlow chart — and falls back to the 'payable' system account (2110)
 * if 2130 is absent. Keeping the net in Accrued Expenses rather than Accounts Payable
 * separates SARS obligations from trade creditors for reporting clarity.
 */
export async function resolveNetVatAccount(companyId: string): Promise<{ id: string }> {
  const rows = (await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${companyId}::UUID
      AND account_code = '2130'
      AND is_active = true
    LIMIT 1
  `) as Row[];

  if (rows.length > 0) return { id: String(rows[0]!.id) };

  // Fallback to system payable account (2110 Accounts Payable)
  log.warn('Account 2130 not found; falling back to payable system account', { companyId }, 'accounting');
  return getSystemAccount('payable', companyId);
}

type Row = DbRow;

/**
 * The day after `isoDate`, as 'YYYY-MM-DD'.
 *
 * Built from explicit UTC parts (never `new Date(str)` + local getters) so it
 * cannot roll back a day for a caller east of UTC, and so month ends, leap-year
 * February and year ends all roll correctly. Accepts a bare date or a timestamp
 * and always returns a bare date. Throws on unparseable input rather than
 * posting a journal with a garbage date.
 */
export function nextDayISO(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) throw new Error(`Invalid periodEnd '${isoDate}' — expected YYYY-MM-DD`);

  const [, y, mo, d] = m;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(utc)) throw new Error(`Invalid periodEnd '${isoDate}' — not a real date`);

  const next = new Date(utc + 86_400_000);
  // Reject 2026-02-30 and friends: Date.UTC rolls them over silently.
  const round = new Date(utc);
  if (round.getUTCMonth() !== Number(mo) - 1 || round.getUTCDate() !== Number(d)) {
    throw new Error(`Invalid periodEnd '${isoDate}' — not a real calendar date`);
  }

  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, '0'),
    String(next.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Refuse to post the clearing journal if its date has no fiscal period (P2-11).
 *
 * `createJournalEntry` INSERTs `fiscal_period_id = NULL` when it cannot resolve
 * a covering period, and `postJournalEntry` guards its closed-period check
 * behind `if (entry.fiscalPeriodId)` — so the entry POSTS and is then invisible
 * to every period-scoped report while still sitting in the ledger. Migration 501
 * names what that cost the last time: Britech's R267,109.70 salary
 * understatement, 200+ rows. A VAT settlement is the worst journal to lose that
 * way: it is the entry that clears the control accounts, so an invisible one
 * leaves the liability standing with no trace of the filing that settled it.
 *
 * V-05 made this reachable by moving the clearing date from periodEnd — always
 * inside the period being filed, and therefore always covered — to
 * periodEnd + 1 day, which can fall past the last period a company has.
 *
 * Scope, deliberately narrow. Only the SILENT case is refused:
 *   - a covering period exists                  → proceed, unchanged;
 *   - none exists but the year is inside
 *     `fiscalPeriodAutoCreate`'s window         → proceed: the write path
 *     creates the year itself, and when it cannot (an existing year with a gap)
 *     it throws on its own — pre-empting that would refuse filings that work;
 *   - none exists and the year is outside it    → REFUSE, before any write.
 *
 * It does NOT create a period. Provisioning a fiscal year is a decision an
 * accountant makes, not a side effect of filing a VAT return.
 */
export async function assertClearingDateHasFiscalPeriod(
  companyId: string,
  clearingDate: string,
): Promise<void> {
  if (await getFiscalPeriodIdForDate(companyId, clearingDate)) return;

  const year = Number(clearingDate.slice(0, 4));
  if (Number.isInteger(year) && isAutoCreatableYear(year)) return;

  throw new Error(
    `Cannot file this VAT return: no fiscal period covers the clearing date ${clearingDate} `
    + `(the first day after the period being filed), and ${year} is outside the range in which `
    + 'fiscal years are created automatically. The settlement journal would post with no fiscal '
    + 'period and be invisible to the trial balance, the VAT201 and the AFS. Create the fiscal '
    + `year ${year} first, then file again.`,
  );
}
