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
 *      Excluded by SUBTYPE, not by account_type, and that distinction is not
 *      theoretical: production carries 356 posted lines on a `vat_input`
 *      account typed as a `liability` rather than an `asset`. A type-based
 *      exclusion would have flagged every one.
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
 * Verified against production before shipping: this rule flags ZERO existing
 * lines. It is a guard against future mistakes, not a backlog of old ones.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { dateStr, r2, toNum } from './vatExceptionsTypes';
import type { VatOnBalanceSheetLine } from './vatExceptionsTypes';

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
    ORDER BY je.entry_date, je.entry_number
    LIMIT ${LIST_CAP}
  ` as Promise<DbRow[]>;
}
