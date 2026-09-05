/**
 * VAT exception: a VAT code claimed against a balance-sheet account.
 *
 * VAT belongs to a SUPPLY. The contra leg of a VAT-bearing journal is normally
 * an income or expense account, and a VAT code sitting on a balance-sheet
 * account usually means the claim has no supply behind it — the classic shape
 * being input VAT coded straight to the bank or to a control account, which
 * overstates field 10 of the VAT201 with nothing to substantiate it.
 *
 * INFORMATIONAL ONLY. This reports; it never blocks a posting. Nothing in the
 * codebase checks account type when a VAT code is applied — not bank
 * allocation, not manual journals, not AP invoices, not the MCP tools — so a
 * hard reject would be the first such gate anywhere and would refuse
 * legitimate postings nobody has enumerated yet. The exceptions report is the
 * right altitude: it is read before filing, which is when the question
 * "should this VAT be here?" is actually answerable.
 *
 * ── WHAT IS DELIBERATELY NOT AN EXCEPTION ───────────────────────────────────
 *
 * A naive "no VAT on balance-sheet accounts" rule is wrong twice over, and both
 * exclusions below are load-bearing rather than defensive:
 *
 *   1. THE VAT CONTROL ACCOUNTS THEMSELVES. `vat_input` is an asset and
 *      `vat_output` a liability, so EVERY VAT-bearing journal has a
 *      balance-sheet leg by construction. Without this exclusion the rule
 *      flags every correctly-coded VAT line in the ledger — 2,042 of them in
 *      production at the time of writing, i.e. all of them.
 *
 *      Excluded by SUBTYPE, not by account_type, because a control account can
 *      be typed either way in a migrated chart.
 *
 *   2. BALANCE-SHEET ACCOUNTS THAT LEGITIMATELY BEAR INPUT VAT IN SOUTH
 *      AFRICA. Capital goods are the headline case — input VAT on a fixed-asset
 *      purchase is claimable, which is why `VatType` already carries
 *      `capital_goods` and vatReturnService maps it to VAT201 boxes 1A and 14.
 *      Trading stock (inventory) and prepaid expenses are the same story: the
 *      supply is real, the account is simply a balance-sheet one.
 *
 * What is left flagged is the set with no legitimate reading: bank accounts
 * (a bank leg is a gross money movement, never a supply), the AR/AP control
 * accounts (already gross — a VAT code here double-counts), equity, retained
 * earnings and accumulated depreciation.
 *
 * WHAT IT FLAGS IN PRODUCTION (re-measured 2026-09-05). The original note here
 * said "ZERO existing lines", and attributed 356 production lines to a
 * `vat_input` account typed as a `liability` — shielded by the subtype
 * exclusion above. Both halves were wrong. Re-running this rule's own
 * predicate across all 13 tenants flags exactly those 356 lines: Velocity
 * Fibre `SYS-9 VAT Payable`, `liability` with `account_subtype` **NULL**, so
 * no exclusion applies to it at all — R4,917,814.24 gross, all `standard`.
 * They are a real, currently unclearable exception feeding `totalExceptions`,
 * and the fix is to give that account a `vat_output` subtype (it is a VAT
 * control account), not to widen the exclusion list. Do not restore the
 * "zero lines" claim without re-running the query.
 *
 * ── WHY THERE IS NO auto_vat_submission EXCLUSION HERE (2026-09-03) ──────────
 *
 * V-05 taught that every aggregation over the VAT control accounts had to
 * exclude vatSubmissionService's clearing journal (vatReturnService,
 * vatControlMovement, and query 1 of vatExceptionsService all carry
 * `je.source IS DISTINCT FROM 'auto_vat_submission'`). This rule does NOT, and
 * that is deliberate — do not add it "for consistency".
 *
 * It cannot fire on that journal today. All three clearing legs are written
 * with no vat_type, and this rule requires `vat_type IS NOT NULL`. Two of the
 * legs are further shielded by subtype (vat_output / vat_input are in the
 * legitimate list above). The THIRD leg is not: the net leg posts to
 * `resolveNetVatAccount` — 2130 Accrued Expenses, subtype
 * `other_current_liability` in production, falling back to 2110 Accounts
 * Payable — and neither subtype is in that list. So one change (anything that
 * starts stamping a vat_type on the clearing journal's lines) would turn that
 * leg into a permanent false exception, one row per filed period.
 *
 * The reason to leave it alone anyway is that the OPPOSITE failure is worse and
 * quieter. This is a per-line coding-legitimacy rule, not a period aggregation:
 * a source exclusion here would suppress a whole journal source from a rule
 * whose entire job is catching miscoded lines. If 'auto_vat_submission' is ever
 * reused for anything hand-editable, genuine exceptions would go dark with no
 * test failing. And because no real path can produce the triggering data, any
 * test written for such an exclusion would be unfalsifiable — a predicate whose
 * removal nothing detects, which is precisely the defect class V-05 was.
 *
 * If you are here because that leg IS now being flagged: the fix belongs in
 * whatever started setting vat_type on the clearing journal, not here.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { dateStr, r2, toNum } from './vatExceptionsTypes';
import type { VatOnBalanceSheetLine } from './vatExceptionsTypes';
import {
  NON_CLAIMING_VAT_TYPES,
  NON_SUPPLY_PATTERN,
  isNonSupplyVatException,
} from './vatNonSupplyExceptions';

/** Balance-sheet account types. `revenue`/`expense` are the income statement. */
export const BALANCE_SHEET_TYPES: readonly string[] = ['asset', 'liability', 'equity'];

/**
 * Subtypes that carry a VAT code legitimately despite being balance-sheet.
 *
 * The first three are the VAT control accounts — the VAT leg itself. The rest
 * are accounts where a real supply is capitalised rather than expensed. Both
 * spellings of the fixed-asset subtype appear in the wild (`leafAccountValidator`
 * accepts either), so both are listed.
 */
export const VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES: readonly string[] = [
  'vat_input',
  'vat_output',
  'tax',
  'fixed_asset',
  'fixed_assets',
  'inventory',
  'other_current_asset',
];

/** `no_vat` means the line was explicitly coded as carrying none. */
const NON_VAT_TYPES: readonly string[] = ['no_vat'];

/**
 * The rule, as a pure predicate.
 *
 * Exported and tested directly so the decision can be exercised without a
 * database, and so the SQL below and this function cannot drift — both read the
 * same two exported constants.
 *
 * DELIBERATELY NOT partition-aware — see `isVatOnBalanceSheetReportException`
 * below. `vatBoxBasis.ts` (line 223) calls THIS one to decide that a line is
 * `unmapped` rather than taxable `base`. Teaching it to yield to the
 * non-supply rule would reclassify a VAT-coded `Net Salaries Payable` line
 * from "excluded" to "part of the box 1/15 taxable base", which is the
 * opposite of correct on a money path. The report's de-duplication is a
 * report concern and lives in the report predicate only.
 */
export function isVatOnBalanceSheetException(line: {
  accountType: string;
  accountSubtype: string | null;
  vatType: string | null;
}): boolean {
  if (line.vatType === null || NON_VAT_TYPES.includes(line.vatType)) return false;
  if (!BALANCE_SHEET_TYPES.includes(line.accountType)) return false;
  return !VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES.includes(line.accountSubtype ?? '');
}

/**
 * The pure twin of `findVatOnBalanceSheetLines` — the rule AS THE EXCEPTIONS
 * REPORT applies it, which is the one above minus the overlap with query 9.
 *
 * THE PARTITION (2026-09-05). A line can satisfy both this rule and
 * `isNonSupplyVatException`: `2170 Net Salaries Payable` (liability,
 * `payroll_liability`) and `2210 Long-term Loans` are balance-sheet accounts
 * whose subtypes are not in the legitimate list AND whose names are
 * non-supply. Production carries 134 such accounts, none with a VAT-coded
 * posted line today — but nothing stops one appearing, and the same line
 * counted by two rules would inflate `totalExceptions`, which
 * `evaluateEfilingGate` turns into a filing refusal.
 *
 * The non-supply rule WINS the overlap and this one yields. Not arbitrary:
 * "employment cost — not a supply" tells the reviewer why the line is wrong,
 * where "it is a liability" only tells them where it sits. No row is lost — it
 * moves section and gains a better reason. The yield is scoped to exactly the
 * rows the other rule returns (name AND a claiming vat_type), so an
 * `exempt`-coded line on a non-supply balance-sheet account — which the other
 * rule deliberately ignores — is still flagged here.
 */
export function isVatOnBalanceSheetReportException(line: {
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  vatType: string | null;
}): boolean {
  if (isNonSupplyVatException(line)) return false;
  return isVatOnBalanceSheetException(line);
}

export function mapVatOnBalanceSheetLine(r: DbRow): VatOnBalanceSheetLine {
  return {
    journalEntryId: String(r.journal_entry_id),
    entryNumber: String(r.entry_number ?? ''),
    entryDate: dateStr(r.entry_date),
    accountCode: String(r.account_code ?? ''),
    accountName: String(r.account_name ?? ''),
    accountType: String(r.account_type ?? ''),
    accountSubtype: r.account_subtype === null || r.account_subtype === undefined
      ? null
      : String(r.account_subtype),
    vatType: String(r.vat_type ?? ''),
    description: String(r.description ?? ''),
    amount: r2(toNum(r.amount)),
  };
}

const LIST_CAP = 100;

/**
 * Posted lines in the period carrying a VAT code against a balance-sheet
 * account that has no legitimate reason to hold one.
 *
 * Company-scoped on BOTH `gl_journal_lines` and `gl_journal_entries`, matching
 * every other query in this report — the line and its entry each carry
 * `company_id` and both are filtered.
 */
export async function findVatOnBalanceSheetLines(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<DbRow[]> {
  return sql`
    SELECT jl.journal_entry_id, je.entry_number, je.entry_date,
      ga.account_code, ga.account_name, ga.account_type, ga.account_subtype,
      jl.vat_type,
      COALESCE(je.description, jl.description, '') AS description,
      jl.debit - jl.credit AS amount,
      COUNT(*) OVER() AS total_count
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date >= ${periodStart}::DATE
      AND je.entry_date <= ${periodEnd}::DATE
      AND jl.vat_type IS NOT NULL
      AND jl.vat_type <> ALL(${NON_VAT_TYPES as string[]}::TEXT[])
      AND ga.account_type = ANY(${BALANCE_SHEET_TYPES as string[]}::TEXT[])
      AND COALESCE(ga.account_subtype, '') <> ALL(
        ${VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES as string[]}::TEXT[]
      )
      -- Yield the overlap to the non-supply rule; see the partition note on
      -- isVatOnBalanceSheetException. Scoped to exactly the rows that rule
      -- returns, so an exempt-coded line on such an account stays here.
      AND NOT (
        ga.account_name ~* ${NON_SUPPLY_PATTERN}
        AND jl.vat_type <> ALL(${NON_CLAIMING_VAT_TYPES as string[]}::TEXT[])
      )
    ORDER BY je.entry_date, je.entry_number
    LIMIT ${LIST_CAP}
  ` as Promise<DbRow[]>;
}
