/**
 * Opening Balance Equity cleared — close-readiness check.
 *
 * The clearing account that opening balances post against should net to
 * ZERO once the full opening trial balance has been captured. A residual at
 * period end means an opening figure is missing or wrong, or the balance has
 * not yet been journaled to retained earnings deliberately. Advisory: warn,
 * never fail — a firm mid-migration legitimately carries a residual for a
 * while, and blocking the close would not make the number more right.
 *
 * Passes silently when the company has no such account: nothing has used the
 * convenience yet, so there is nothing to clear.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ChecklistItem } from '../periodCloseReadinessService';
import { OPENING_BALANCE_EQUITY_SUBTYPE } from '../openingBalanceEquityService';

const TOLERANCE = 0.01;
const KEY = 'opening_balance_cleared' as const;
const LABEL = 'Opening balance equity cleared';
const HREF = '/accounting/chart-of-accounts';

export async function openingBalanceEquityCheck(
  companyId: string,
  period: { endDate: string },
): Promise<ChecklistItem> {
  const rows = (await sql`
    SELECT COUNT(DISTINCT ga.id) AS accounts,
           COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit - jl.debit END), 0) AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines jl
      ON jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
    LEFT JOIN gl_journal_entries je
      ON je.id = jl.journal_entry_id AND je.company_id = ${companyId}::UUID
         AND je.status = 'posted' AND je.entry_date <= ${period.endDate}::date
    WHERE ga.company_id = ${companyId}::UUID
      AND ga.account_subtype = ${OPENING_BALANCE_EQUITY_SUBTYPE}
      -- is_active is a picker flag, never a statement about the balance: a
      -- residual on a deactivated clearing account is exactly the uncleared
      -- opening balance this check exists to surface.
      AND ga.is_system_account = true
  `) as DbRow[];
  const accounts = Number(rows[0]?.accounts ?? 0);
  if (accounts === 0) {
    return { key: KEY, label: LABEL, status: 'pass', reason: 'No opening balance equity account in use.', fixHref: HREF };
  }
  // A line whose entry is unposted or after period end has je.id NULL and
  // contributes nothing — the CASE, not the LEFT JOIN, is what enforces that.
  const balance = Number(rows[0]?.balance ?? 0);
  if (Math.abs(balance) <= TOLERANCE) {
    return { key: KEY, label: LABEL, status: 'pass', reason: 'Opening balance equity nets to zero.', fixHref: HREF };
  }
  return {
    key: KEY,
    label: LABEL,
    status: 'warn',
    reason: `Opening balance equity carries R${balance.toFixed(2)} at period end — an opening figure is missing, or the residual has not been moved to retained earnings.`,
    fixHref: HREF,
  };
}
