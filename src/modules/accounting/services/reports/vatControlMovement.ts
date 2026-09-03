/**
 * Raw GL movement on the VAT control accounts for a period.
 *
 * The GL half of the VAT201-vs-GL reconciliation in `vatExceptionsService`:
 * the invoice-derived VAT201 (from `generateVAT201`) is the other half, and the
 * difference between them is the posting gap the exceptions report exists to
 * surface.
 *
 * ── WHY THIS IS NOT `getVATReturn` ──────────────────────────────────────────
 *
 * `getVATReturn` also reads the VAT control accounts, and collapsing the two
 * looks tempting. It would be wrong — they do not compute the same number:
 *
 *   1. ACCOUNT SELECTION. `getVATReturn` also selects `account_subtype = 'tax'`
 *      (18 posted lines in production, on an EXPENSE-typed account). This query
 *      selects only the two control subtypes.
 *   2. SIDE ASSIGNMENT. `getVATReturn` calls a line output when
 *      `account_type = 'liability'` OR `subtype = 'vat_output'`, and input when
 *      `account_type = 'asset'` OR `subtype = 'vat_input'`. Mis-typed control
 *      accounts exist in the wild, and one lands on the opposite side there
 *      from here, which keys off subtype alone.
 *   3. VAT_TYPE FILTERING. `getVATReturn` keeps only the vat_types its box
 *      table maps; anything else (an unmapped or future VatType) is dropped
 *      from its totals. This query counts every line regardless of coding.
 *
 * Point 3 is the whole reason the recon exists: a GL line the box mapping
 * cannot place must show up as a VARIANCE, not vanish silently. Unify these two
 * only after making them agree on all three points.
 *
 * ── WHAT THEY DO SHARE ──────────────────────────────────────────────────────
 *
 * `je.source IS DISTINCT FROM 'auto_vat_submission'` (V-05).
 * `vatSubmissionService` posts its settlement journal against these same
 * control accounts, moving the period's entire output and input tax back off
 * them — so without the predicate the GL side of the recon collapsed to
 * near-nil (R11,363 of output against a VAT201 of R292,096 on the demo
 * company) and the report compared a correct invoice figure against a
 * contaminated one.
 *
 * IS DISTINCT FROM, not a plain inequality: `source` is nullable and an
 * inequality against NULL yields NULL, which would silently drop every
 * NULL-source journal. The predicate is narrow by construction —
 * 'auto_vat_submission' is written in exactly one place, and
 * `gl_journal_entries_source_check` carries 'auto_vat_adjustment' as a SEPARATE
 * value, so manual and automated VAT adjustments are still counted. The full
 * reasoning lives at the same predicate in `vatReturnService`.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * One row: `gl_output` (credit − debit on vat_output accounts) and `gl_input`
 * (debit − credit on vat_input accounts), both as pg numeric strings.
 *
 * Company-scoped on BOTH `gl_journal_lines` and `gl_journal_entries`, matching
 * every other query in this report.
 */
export async function findVatControlMovement(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<DbRow[]> {
  return sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_output'
        THEN jl.credit - jl.debit ELSE 0 END), 0) AS gl_output,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_input'
        THEN jl.debit - jl.credit ELSE 0 END), 0) AS gl_input
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date >= ${periodStart}::DATE
      AND je.entry_date <= ${periodEnd}::DATE
      AND je.source IS DISTINCT FROM 'auto_vat_submission'
      AND ga.account_subtype IN ('vat_input', 'vat_output')
  ` as Promise<DbRow[]>;
}
