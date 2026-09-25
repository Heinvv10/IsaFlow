/**
 * Which journals the VAT201 snapshot folds in: a journal is VAT-BEARING when
 * ANY of its lines is a member line —
 *
 *   - a line on a VAT control account (raw subtype vat_input / vat_output —
 *     NOT the generic `tax`, which is PAYE as often as VAT), or
 *   - a line carrying a VAT code (not `no_vat`) that is either on a
 *     balance-sheet account with no VAT treatment, or on the generic `tax`
 *     subtype.
 *
 * Plus one journal-level exclusion, `vatEntrySourceAdmitsSql` below.
 *
 * ONE rule, as SQL: the snapshot query (vatBoxBasisQuery `vat_entries`)
 * splices it in over the real account rows, and the VAT-lock reclassification
 * check (gl/vatLockLineClassification `memberLineUnderSql`) splices it in with
 * changing accounts' before/after attributes substituted. The integration test
 * tests/integration/vat-entry-membership-agreement.int.test.ts pins the
 * substituted form against the plain one over real lines.
 */
import { sql } from '@/lib/neon';
import {
  BALANCE_SHEET_TYPES,
  VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES,
} from './vatBalanceSheetExceptions';
import { VAT_TAX_SUBTYPES } from './vatBoxBasis';

export const NON_VAT_TYPES: readonly string[] = ['no_vat'];

/**
 * The JOURNAL-level half of the rule: the VAT submission clearing journal
 * (vatSubmissionService, source 'auto_vat_submission', dated day 1 of the
 * FOLLOWING period) is never folded in. It settles the previous return — DR
 * VAT Output / CR VAT Input / the net to accrued — and is no supply, so read
 * as one it reduced the next period's FILED fields 5 and 10 by the previous
 * period's tax, and its lock snapshot and export with them (Hein, 2026-09-25;
 * the V-05 exclusion vatReturnService and vatControlMovement already carry).
 * IS DISTINCT FROM, not `<>`: `source` is nullable, and NULL <> x is NULL.
 * `source` is the journal's source column expression (`je.source`, `e.source`).
 */
export function vatEntrySourceAdmitsSql(source: ReturnType<typeof sql>) {
  return sql`${source} IS DISTINCT FROM 'auto_vat_submission'`;
}

/** Column expressions the fragment reads. Default: the real account row. */
export interface MemberLineColumns {
  accountType: ReturnType<typeof sql>;
  accountSubtype: ReturnType<typeof sql>;
  vatType: ReturnType<typeof sql>;
}

/**
 * The member-line predicate as SQL, by default over aliases `jl`
 * (gl_journal_lines) and `ga` (gl_accounts). `cols` lets a caller evaluate it
 * against OTHER account attributes — the VAT-lock check substitutes an
 * account's before/after attributes for the accounts an operation changes. A
 * function, not a module constant: a fragment built at import time would
 * shift every positional `sql` mock in the unit suite.
 */
export function vatEntryMemberLineSql(cols?: MemberLineColumns) {
  const type = cols?.accountType ?? sql`ga.account_type`;
  const subtype = cols?.accountSubtype ?? sql`ga.account_subtype`;
  const vatType = cols?.vatType ?? sql`jl.vat_type`;
  return sql`(
    COALESCE(${subtype}, '') = ANY(${VAT_TAX_SUBTYPES as unknown as string[]}::TEXT[])
    OR (
      ${vatType} IS NOT NULL
      AND ${vatType} <> ALL(${NON_VAT_TYPES as string[]}::TEXT[])
      AND (
        -- A VAT code on a balance-sheet account with no VAT treatment.
        (
          ${type} = ANY(${BALANCE_SHEET_TYPES as string[]}::TEXT[])
          AND COALESCE(${subtype}, '') <> ALL(
            ${VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES as string[]}::TEXT[]
          )
        )
        -- Or on the GENERIC tax subtype, which is PAYE as often as VAT.
        OR COALESCE(${subtype}, '') = 'tax'
      )
    )
  )`;
}
