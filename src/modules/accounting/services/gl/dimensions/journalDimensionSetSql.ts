/**
 * ONE rule for "which CC1 / CC2 / BU does this bank row's allocation journal
 * carry", as a LATERAL join shared by the Banking list (DIMENSION_JOINS in
 * bank/bankTxQueryFragments.ts) and the bank-row sync (dimensionBankSync.ts), so
 * the screen and the sync cannot disagree about what is a split.
 *
 * The journal is the one holding the bank row's matched_journal_line_id, and it
 * counts only when it is POSTED (a draft or reversed journal's tags are not the
 * books'). Its DIMENSION LINES are every line other than the bank leg that is
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

/**
 * SQL for `isControlSubtype(<column>)`. The column is compared the way
 * `canonicalSubtype` reads a raw subtype: trimmed, lower-cased, runs of
 * whitespace / hyphens as '_'. `column` is a SQL expression written by the caller, never a user value.
 */
export const isControlSubtypeSql = (column: string): string =>
  `COALESCE(regexp_replace(lower(btrim(${column})), '[[:space:]-]+', '_', 'g'), '') = ANY (ARRAY[${CONTROL_LIST}]::TEXT[])`;

export const JOURNAL_DIMENSION_SET_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT (array_agg(dl.cc1_id))[1] AS cc1, (array_agg(dl.cc2_id))[1] AS cc2, (array_agg(dl.bu_id))[1] AS bu,
           COUNT(DISTINCT ROW(dl.cc1_id, dl.cc2_id, dl.bu_id)::TEXT) AS sets,
           COUNT(*) FILTER (WHERE dl.cc1_id IS NOT NULL OR dl.cc2_id IS NOT NULL OR dl.bu_id IS NOT NULL) AS tagged
    FROM gl_journal_lines dbl
    JOIN gl_journal_entries dje
      ON dje.id = dbl.journal_entry_id AND dje.company_id = dbl.company_id AND dje.status = 'posted'
    JOIN gl_journal_lines dl
      ON dl.journal_entry_id = dbl.journal_entry_id AND dl.company_id = dbl.company_id AND dl.id <> dbl.id
    JOIN gl_accounts dla ON dla.id = dl.gl_account_id AND dla.company_id = dl.company_id
    WHERE dbl.id = bt.matched_journal_line_id
      AND dbl.company_id = bt.company_id
      AND NOT (${isControlSubtypeSql('dla.account_subtype')})
  ) jd ON TRUE`;
