/**
 * `posted_through` — the latest ledger write a figure consumed.
 *
 * It is what makes a number re-derivable. A trial balance signed on 3 September
 * and re-run on the 10th will differ if anyone back-dated a journal in between,
 * and nothing else in the API lets a reader tell that from an arithmetic error.
 * Same `as_at` plus same `posted_through` must give the same figures.
 *
 * It is `MAX(created_at)` of the rows consumed — NEVER `now()`, which changes
 * on every call and proves nothing.
 *
 * CANONICAL RULE, settled in `docs/mcp/CONTRACTS.md`: `posted_through` is
 * `string | null`, and `null` — never `NO_LEDGER_READ` below — is the correct
 * answer when a report consumed no ledger row. A sentinel timestamp is a
 * valid value of its own type, so `new Date(posted_through) > x` parses it
 * exactly as happily as a real reading and returns a plausible wrong answer;
 * `null` forces the check instead of hiding it. `getLedgerPostedThrough`
 * below still returns the epoch rather than `null` — this was the exact
 * pattern several MCP tools copied before the contract was written down —
 * and converging it, along with the nine tool-layer `?? NO_LEDGER_READ` /
 * `postedThroughOr(...)` call sites (`reconcileSubledger`, `generalLedger`,
 * `payroll`, `payrollSars`, `jobCost`, `inventoryAndAp`, `domainReports`,
 * `budgetVariance`, `assets`), is a known, scheduled follow-up — its own PR,
 * reviewed on its own, not folded into whichever branch happens to touch this
 * file next. Do NOT add a tenth site copying this pattern; return the real
 * `string | null` and let the caller decide, per the contract.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * A read that consumed no ledger row.
 *
 * @deprecated Do not use in new code. The contract now requires `null` here,
 * not a sentinel — see the file-level docblock above and
 * `docs/mcp/CONTRACTS.md`'s "`posted_through` is not decoration" section for
 * why a same-type sentinel is worse than an absent value, not merely
 * equivalent to one. Kept exported, and `getLedgerPostedThrough` below still
 * returns it, only because converging the existing call sites is a separate,
 * scheduled PR — see the file-level docblock.
 */
export const NO_LEDGER_READ = '1970-01-01T00:00:00.000Z';

/**
 * MAX(created_at) over the POSTED journal entries a report reads: everything
 * dated on or before `asAtDate`, optionally from `fromDate`.
 *
 * @param asAtDate 'YYYY-MM-DD'. String throughout — no Date arithmetic; SAST is
 *   UTC+2 and this repo has a live UTC-rollback defect class.
 */
export async function getLedgerPostedThrough(
  companyId: string,
  asAtDate: string,
  fromDate?: string,
): Promise<string> {
  const from = fromDate ?? null;
  const rows = (await sql`
    SELECT MAX(je.created_at) AS posted_through
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${asAtDate}::DATE
      AND (${from}::TEXT IS NULL OR je.entry_date >= ${from}::DATE)
  `) as DbRow[];
  const raw = rows[0]?.posted_through;
  if (raw == null) return NO_LEDGER_READ;
  return raw instanceof Date ? raw.toISOString() : String(raw);
}
