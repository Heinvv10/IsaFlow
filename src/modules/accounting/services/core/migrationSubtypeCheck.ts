/**
 * Go-live check: does every account carrying value have a USABLE
 * `account_subtype`?
 *
 * WHY THIS EXISTS. `account_subtype` is optional on import and is plain TEXT
 * with no CHECK constraint. `aggregateFigures`
 * (`../gl/accountClassification.ts`) does not leave an unbanded subtype
 * unbanded, it DEFAULTS it, and each default moves money between two reported
 * lines. On Velocity Fibre 60 of 60 imported expense accounts, 14 of 14
 * liability and 6 of 6 revenue accounts arrived NULL, and nothing warned:
 * go-live validation ran six checks and none looked at ordinary subtypes.
 * R82,727,277.95 of direct cost was banded as operating expense, reporting a
 * 96.6% gross margin on fibre construction against a real -1.9% (finding B61).
 *
 * "USABLE" IS THE POINT, AND IT IS NOT `IS NULL`. Recognition is decided in
 * TypeScript by `canonicalSubtype` — the same function the classifier bands
 * with — so this check cannot drift from what the reports actually do. An
 * `IS NULL` predicate would miss the empty string, whitespace, and a real
 * spelling the alias table does not know. Production carries two of the last
 * kind: `other`, on ISAFlow Demo's `2210 Long-term Loans` (R3,049,137.84,
 * defaulted into CURRENT liabilities), and `disposal_profit_loss`, seeded on
 * revenue accounts across most tenants and defaulted into turnover.
 *
 * A ZERO BALANCE IS NOT NO MOVEMENT. Gross movement is read alongside the net
 * balance, because Velocity's `1564412 ABSA - PC` is a BANK account with 18
 * posted lines, no subtype and a nil balance. That one account also falsifies
 * the comfortable story about this defect — that the Sage path fills in `bank`
 * because a missing `bank` breaks visibly, `getBankAccountsStatus` selecting
 * `WHERE account_subtype = 'bank'`. It did not break visibly. It is simply
 * absent from the bank list and from `f.cash`, and will stay absent until
 * someone notices the next deposit is in current assets but not in cash.
 *
 * WHAT THIS CHECK CANNOT DO, AND WHO HAS TO DECIDE IT. It runs on the
 * migration wizard's validation step, which renders only while a migration
 * session is open. Velocity Fibre and Brightsphere have COMPLETED migrations,
 * so neither will ever see it, and every account created after go-live can
 * arrive unbanded with nothing re-running. The defect is chart-shaped, not
 * migration-shaped; the standing surface it belongs on is
 * `chartOfAccountsHealthService`. That is a scope decision, not an omission —
 * registered as B71.
 *
 * THE REAL FIX IS UPSTREAM AND IS NOT BUILT HERE. The import wizard should ask
 * for subtypes while the operator is already mapping the 14 system roles — the
 * one moment the knowledge is in the room. A check at go-live only reports that
 * the moment has passed.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { ValidationResult } from './migrationValidationService';
import {
  buildSubtypeCoverageResult,
  type AccountMovementRow,
} from './migrationSubtypeMessage';

export {
  buildSubtypeCoverageResult,
  formatRand,
  isUnbanded,
  SUBTYPE_COVERAGE_CHECK,
  type AccountMovementRow,
} from './migrationSubtypeMessage';

/**
 * Every account on the company with at least one POSTED journal line, with both
 * its net balance and its gross movement.
 *
 * Deliberately NOT filtered on subtype in SQL. Recognition belongs to
 * `canonicalSubtype`, and a `NOT IN (...)` list here would be a second copy of
 * the vocabulary that silently rots when an alias is added. The row count is
 * bounded by the chart — 111 accounts on the largest production tenant — so
 * filtering in TypeScript costs nothing and keeps one definition of "banded".
 *
 * `is_active` is not filtered, matching `financialFiguresService`: a
 * deactivated account's posted lines still reach every report.
 */
export async function fetchAccountMovement(companyId: string): Promise<AccountMovementRow[]> {
  const rows = (await sql`
    SELECT
      ga.account_code,
      ga.account_name,
      ga.account_type,
      ga.account_subtype,
      COALESCE(SUM(COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0)), 0) AS net,
      COALESCE(SUM(COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0)), 0) AS gross
    FROM gl_accounts ga
    JOIN gl_journal_lines jl
      ON jl.gl_account_id = ga.id
     AND jl.company_id = ${companyId}::UUID
    JOIN gl_journal_entries je
      ON je.id = jl.journal_entry_id
     AND je.company_id = ${companyId}::UUID
    WHERE ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype
  `) as DbRow[];

  return rows.map(r => ({
    account_code: String(r.account_code ?? ''),
    account_name: String(r.account_name ?? ''),
    account_type: String(r.account_type ?? ''),
    account_subtype: r.account_subtype == null ? null : String(r.account_subtype),
    net: (r.net ?? 0) as number | string,
    gross: (r.gross ?? 0) as number | string,
  }));
}

/** The go-live check itself. */
export async function checkAccountSubtypeCoverage(companyId: string): Promise<ValidationResult> {
  return buildSubtypeCoverageResult(await fetchAccountMovement(companyId));
}
