/**
 * Go-live check: does every account carrying value have an `account_subtype`?
 *
 * WHY THIS EXISTS. `account_subtype` is optional on import. The Sage path fills
 * in only `bank`, because a missing `bank` breaks visibly —
 * `getBankAccountsStatus` selects `WHERE account_subtype = 'bank'`. Every other
 * subtype fails quietly: `aggregateFigures`
 * (`../gl/accountClassification.ts`) does not leave an unrecognised subtype
 * unbanded, it DEFAULTS it, and each default moves money between two reported
 * lines:
 *
 *   expense   → operating expenses (not cost of sales) — OVERSTATES gross profit
 *   asset     → current assets     — overstates working capital and the current ratio
 *   liability → current liabilities
 *   revenue   → turnover (not other income) — overstates revenue
 *
 * On Velocity Fibre 60 of 60 imported expense accounts, 14 of 14 liability and
 * 6 of 6 revenue accounts arrived NULL, and nothing warned: go-live validation
 * ran six checks and none looked at ordinary subtypes. R82,727,277.95 of direct
 * cost was banded as operating expense, reporting a 96.6% gross margin on fibre
 * construction against a real -1.9% (finding B61).
 *
 * THE REAL FIX IS UPSTREAM AND IS NOT BUILT HERE. The import wizard should ask
 * for subtypes while the operator is already mapping the 14 system roles — that
 * is the moment the knowledge is in the room, and a check at go-live only tells
 * someone that the moment has passed. This ships the check.
 *
 * SCOPE. Flags `account_subtype IS NULL` only. An account carrying a subtype
 * spelling `canonicalSubtype` does not recognise defaults identically, and
 * `aggregateFigures` already discloses both together in `unclassifiedByType` —
 * widening this check to unrecognised spellings is a separate change with its
 * own evidence.
 *
 * Zero-movement accounts are NOT flagged. A chart heading with no postings is
 * not yet a problem, and flagging it buries the accounts that are.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { ValidationResult } from './migrationValidationService';

/** One NULL-subtype account with its net posted movement. */
export interface UnclassifiedAccountRow {
  account_code: string;
  account_name: string;
  account_type: string;
  /** Net `debit - credit` over posted lines. pg returns NUMERIC as a string. */
  balance: number | string | null;
}

export const SUBTYPE_COVERAGE_CHECK = 'Account Subtype Coverage';

/** Below half a cent is rounding dust, not movement. */
const MATERIAL = 0.005;

/** How many accounts to name before summarising the rest. */
const NAMED_LIMIT = 5;

/** What the fallback costs, per account type, in the reader's terms. */
const COST_BY_TYPE: Record<string, string> = {
  expense: 'lands in operating expenses instead of cost of sales, overstating gross profit',
  asset: 'lands in current assets, overstating working capital and the current ratio',
  liability: 'lands in current liabilities, understating long-term debt',
  revenue: 'lands in turnover instead of other income, overstating revenue',
};

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

/** `1234567.5` → `R1,234,567.50`. Deterministic; no locale dependency. */
export function formatRand(value: number): string {
  const fixed = Math.abs(value).toFixed(2);
  const [whole = '0', cents = '00'] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}R${grouped}.${cents}`;
}

/**
 * Band the rows into a validation result. Pure — the DB half is
 * `checkAccountSubtypeCoverage` below.
 *
 * Warns, never fails: this is an exceptions report, on the same footing as the
 * VAT-on-balance-sheet report. The books are internally consistent and the
 * trial balance still balances; what is wrong is where the money is REPORTED,
 * which a person has to adjudicate account by account. Blocking go-live on it
 * would stop a migration nobody can unblock without that adjudication.
 */
export function buildSubtypeCoverageResult(
  rows: readonly UnclassifiedAccountRow[],
): ValidationResult {
  const material = rows
    .map(r => ({ ...r, amount: num(r.balance) }))
    .filter(r => Math.abs(r.amount) >= MATERIAL)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  if (material.length === 0) {
    return {
      check: SUBTYPE_COVERAGE_CHECK,
      status: 'pass',
      message: 'Every account carrying value has an account_subtype',
    };
  }

  const total = material.reduce((sum, r) => sum + Math.abs(r.amount), 0);
  const types = [...new Set(material.map(r => r.account_type))].sort();

  const consequences = types
    .map(t => (COST_BY_TYPE[t] ? `a ${t} account with no subtype ${COST_BY_TYPE[t]}` : null))
    .filter((s): s is string => s !== null);

  const named = material
    .slice(0, NAMED_LIMIT)
    .map(r => `${r.account_code} ${r.account_name} (${r.account_type}) ${formatRand(r.amount)}`);
  const remaining = material.length - named.length;
  if (remaining > 0) named.push(`and ${remaining} more`);

  return {
    check: SUBTYPE_COVERAGE_CHECK,
    status: 'warn',
    message:
      `${material.length} account(s) carrying ${formatRand(total)} have no account_subtype. ` +
      'These are not left out of the reports — they are silently defaulted: ' +
      `${consequences.join('; ')}. Set a subtype on each before anyone reads a report.`,
    detail: `Largest: ${named.join('; ')}`,
  };
}

/**
 * Every account on the company whose `account_subtype` is NULL and which has at
 * least one POSTED journal line, with its net movement.
 *
 * The non-zero test is deliberately NOT in the SQL. An account whose lines net
 * to zero (Velocity's `1000 Assets` and `1100 Current Assets` each carry four
 * posted lines summing to nil) comes back at zero and is dropped by
 * `buildSubtypeCoverageResult`, which makes the zero-movement exclusion a unit
 * test rather than a claim about a query nothing can run without a database.
 */
export async function fetchUnclassifiedAccounts(
  companyId: string,
): Promise<UnclassifiedAccountRow[]> {
  const rows = (await sql`
    SELECT
      ga.account_code,
      ga.account_name,
      ga.account_type,
      COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
    FROM gl_accounts ga
    JOIN gl_journal_lines jl
      ON jl.gl_account_id = ga.id
     AND jl.company_id = ${companyId}::UUID
    JOIN gl_journal_entries je
      ON je.id = jl.journal_entry_id
     AND je.company_id = ${companyId}::UUID
    WHERE ga.company_id = ${companyId}::UUID
      AND ga.account_subtype IS NULL
      AND je.status = 'posted'
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type
  `) as DbRow[];

  return rows.map(r => ({
    account_code: String(r.account_code ?? ''),
    account_name: String(r.account_name ?? ''),
    account_type: String(r.account_type ?? ''),
    balance: (r.balance ?? 0) as number | string,
  }));
}

/** The go-live check itself. */
export async function checkAccountSubtypeCoverage(companyId: string): Promise<ValidationResult> {
  return buildSubtypeCoverageResult(await fetchUnclassifiedAccounts(companyId));
}
