/**
 * ONE rule for "which CC1 / CC2 / BU does this bank row's allocation journal
 * carry", as a LATERAL join shared by the Banking list (DIMENSION_JOINS in
 * bank/bankTxQueryFragments.ts) and the bank-row sync (dimensionBankSync.ts), so
 * the screen and the sync cannot disagree about what is a split.
 *
 * The journal is the one holding the bank row's matched_journal_line_id, and it
 * counts only when it STANDS: status 'posted' (a draft's tags are not the books')
 * AND not reversed, AND not itself a reversal. A reversal never changes status —
 * the service stamps `reversed_at` and posts a contra with `reversal_of_id` — so
 * 'standing' is `reversed_at IS NULL`, `reversal_of_id IS NULL` and no POSTED entry
 * naming it (a hand-posted reversal need not set reversed_at; the three-signal
 * rule of ap_journal_entry_is_reversed, migration 680). A re-reversed chain's
 * original keeps its reversed_at, so it is skipped too: the safe side for a copy.
 *
 * Its DIMENSION LINES are every line other than the bank leg that is
 * not on a control account (bank, cash, card, AP, AR, VAT, payroll clearing —
 * `isControlSubtype`): exactly the lines a tag or an allocation may put a
 * dimension on, and so the lines whose tags the bank row has to agree with.
 * An allocation to one expense with VAT is the expense line (tagged) plus the
 * VAT and bank legs (control, ignored): ONE set. A split allocation to two
 * expenses, one tagged and one not, is TWO sets (a partial tagging).
 *
 * Exposes `jd`, always one row:
 *   sets    distinct (cc1, cc2, bu) combinations over the dimension lines — NULLs
 *           count as a value, so tagged-vs-untagged differs; 0 = no usable
 *           journal or no dimension line (a supplier payment: AP + bank)
 *   tagged  dimension lines carrying any of the three
 *   cc1/cc2/bu  the agreed values; meaningful only when sets = 1
 * The caller's bank-transaction alias must be `bt`.
 */
import { CONTROL_RAW_SUBTYPES } from './dimensionPolicy';

const CONTROL_LIST = CONTROL_RAW_SUBTYPES.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');

// JS `\s` and String.trim() share one whitespace set (WhiteSpace + LineTerminator); PostgreSQL's btrim and
// [[:space:]] cover only ASCII space and the C0 controls, so NBSP, U+2028 and the rest must be spelled out.
const JS_SPACE = String.raw`[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`;

/**
 * SQL for `isControlSubtype(<column>)`. The column is read exactly as
 * `canonicalSubtype` reads a raw subtype: `.trim()`, `.toLowerCase()`, then
 * `.replace(/[\s-]+/g, '_')` — with JS's whitespace set, not Postgres's.
 * `column` is a SQL expression written by the caller, never a user value.
 */
export const isControlSubtypeSql = (column: string): string =>
  `COALESCE(regexp_replace(regexp_replace(lower(${column}), '^${JS_SPACE}+|${JS_SPACE}+$', '', 'g'), '[${JS_SPACE.slice(1, -1)}-]+', '_', 'g'), '') = ANY (ARRAY[${CONTROL_LIST}]::TEXT[])`;

export const JOURNAL_DIMENSION_SET_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT (array_agg(dl.cc1_id))[1] AS cc1, (array_agg(dl.cc2_id))[1] AS cc2, (array_agg(dl.bu_id))[1] AS bu,
           COUNT(DISTINCT ROW(dl.cc1_id, dl.cc2_id, dl.bu_id)::TEXT) AS sets,
           COUNT(*) FILTER (WHERE dl.cc1_id IS NOT NULL OR dl.cc2_id IS NOT NULL OR dl.bu_id IS NOT NULL) AS tagged
    FROM gl_journal_lines dbl
    JOIN gl_journal_entries dje
      ON dje.id = dbl.journal_entry_id AND dje.company_id = dbl.company_id AND dje.status = 'posted'
     AND dje.reversed_at IS NULL AND dje.reversal_of_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM gl_journal_entries dr
                     WHERE dr.company_id = dje.company_id AND dr.reversal_of_id = dje.id AND dr.status = 'posted')
    JOIN gl_journal_lines dl
      ON dl.journal_entry_id = dbl.journal_entry_id AND dl.company_id = dbl.company_id AND dl.id <> dbl.id
    JOIN gl_accounts dla ON dla.id = dl.gl_account_id AND dla.company_id = dl.company_id
    WHERE dbl.id = bt.matched_journal_line_id
      AND dbl.company_id = bt.company_id
      AND NOT (${isControlSubtypeSql('dla.account_subtype')})
  ) jd ON TRUE`;
