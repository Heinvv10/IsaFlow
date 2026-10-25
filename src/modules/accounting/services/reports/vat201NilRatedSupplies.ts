/**
 * Zero-rated and exempt supply VALUES, from the journal lines that carry them.
 *
 * WHY NOT FROM THE VAT BOXES. `getVat201Report` builds a box only from a VAT
 * control leg: `vatBoxBasisQuery` selects a journal into the return only when
 * it posts to a `vat_input`/`vat_output` account, and `deriveVatBoxes`
 * attributes base only to the VAT types its tax legs name. An export or an
 * exempt supply raises NO VAT, posts NO control leg, and is invisible to that
 * basis — its journal is never even selected. Fields 2 and 3 are compulsory
 * disclosures, so filing zero export turnover misstates the return.
 *
 * WHY PER LINE AND NOT PER DOCUMENT. Reading one VAT code off a document and
 * applying it to the whole subtotal double-counts a mixed invoice: an R1 500
 * invoice of R1 000 standard plus R500 exempt reported its ENTIRE subtotal in
 * field 3 while the ledger independently reported the taxed part in field 1 —
 * R3 000 of supplies declared for an R1 500 invoice. A journal line carries its
 * own `vat_type`, so the R500 goes to field 3 and only the R500.
 *
 * `onTaxedJournals` is the other half of that correction. Where a nil-rated line
 * sits on a journal that DOES carry a VAT control leg, `deriveVatBoxes` has
 * already folded its value into the taxed output base — it apportions a
 * journal's whole base pro-rata by tax, and a zero-tax type takes none — so the
 * caller subtracts this from field 1 to stop the same rand being declared twice.
 *
 * POSTED ONLY, matching the ledger fields. A draft invoice on a draft journal
 * used to reach field 2 while every ledger field ignored it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** Both spellings of a killed document are in use across AR and the credit notes. */
const CANCELLED_STATUSES: readonly string[] = ['cancelled', 'void', 'voided'];

const EXPORT_TYPE = 'export';
const ZERO_RATED_TYPES: readonly string[] = ['zero_rated', EXPORT_TYPE];
const EXEMPT_TYPES: readonly string[] = ['exempt', 'no_vat'];
const NIL_RATED_TYPES: readonly string[] = [...ZERO_RATED_TYPES, ...EXEMPT_TYPES];

export interface NilRatedSupplies {
  /** Zero-rated supplies, exports included, net of zero-rated credit notes. */
  zeroRated: number;
  /** The `export` part of `zeroRated` — SARS field 2A; field 2 is `zeroRated` less this. */
  exported: number;
  /** Field 3 — exempt supplies, net of exempt credit notes. */
  exempt: number;
  /**
   * The part of the above already inside the taxed output base, which field 1
   * must therefore give up. Zero on a book whose nil-rated supplies are all
   * raised on their own journals.
   */
  onTaxedJournals: number;
  /** Part of `onTaxedJournals` on journals whose taxed output legs are ALL capital goods: it comes off field 1A, not field 1. */
  onTaxedCapital: number;
  /** Part of `onTaxedJournals` on journals mixing capital and other taxed legs: not attributable to 1 or 1A, so the page warns. */
  onTaxedAmbiguous: number;
  /** Part of `zeroRated` from revenue lines with NO vat code on wholly untaxed documents: assumed zero-rated, for the user to confirm. */
  uncodedAssumedZeroRated: number;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Sum the period's nil-rated customer supplies from the revenue legs that carry
 * a nil VAT code.
 *
 * Turnover is a credit to revenue, so the value is `credit - debit` on
 * `account_type = 'revenue'`: a credit note debits the same account and nets
 * off. A revenue leg with NO VAT code counts only when its document raised no
 * tax at all — that is the old invoice-derived fallback, kept for books that
 * never coded their lines, and confined to wholly untaxed documents so it can
 * never claim the untaxed share of a mixed one.
 */
export async function getNilRatedSupplies(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<NilRatedSupplies> {
  const rows = (await sql`
    WITH taxed_entries AS (
      -- Journals whose base deriveVatBoxes puts on a TAXED output box, which
      -- is the only case where field 1 must give the nil-rated share back.
      -- The test is the OUTPUT control leg's own VAT code, not its amount:
      --   * a wholly zero-rated invoice posting a R0.00 leg coded zero_rated
      --     has one output type, so the whole base goes to box 2 - no deduction,
      --     and deducting made field 1 render minus the export turnover;
      --   * the same invoice posting a R0.00 leg coded standard has one TAXED
      --     type, so the whole base goes to box 1 - the deduction is required,
      --     or the R20 000 is declared in both field 1 and field 2;
      --   * a mixed journal's nil-rated type takes a pro-rata share of nil, so
      --     its base sits on box 1 whatever the nil-rated leg is worth.
      -- A leg with no code at all defaults to standard there, so it is taxed.
      -- has_capital / has_other: which taxed types the journal's output legs name,
      -- so the nil-rated share is given back by the box it was apportioned into.
      SELECT jl.journal_entry_id AS id,
             bool_or(jl.vat_type = 'capital_goods') AS has_capital,
             bool_or(jl.vat_type IS DISTINCT FROM 'capital_goods') AS has_other
      FROM gl_journal_lines jl
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${companyId}::UUID
        AND COALESCE(ga.account_subtype, '') = 'vat_output'
        AND (jl.vat_type IS NULL OR jl.vat_type <> ALL(${NIL_RATED_TYPES as string[]}::TEXT[]))
      GROUP BY jl.journal_entry_id
    ),
    cancelled_entries AS (
      SELECT ci.gl_journal_entry_id AS id FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID
          AND ci.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND ci.gl_journal_entry_id IS NOT NULL
      UNION
      SELECT cn.gl_journal_entry_id FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID
          AND cn.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND cn.gl_journal_entry_id IS NOT NULL
    ),
    untaxed_documents AS (
      SELECT ci.gl_journal_entry_id AS id FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID
          AND COALESCE(ci.tax_amount, 0) = 0
          AND ci.status <> ALL(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND ci.gl_journal_entry_id IS NOT NULL
      UNION
      SELECT cn.gl_journal_entry_id FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID
          AND cn.type = 'customer'
          AND COALESCE(cn.tax_amount, 0) = 0
          AND cn.status <> ALL(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND cn.gl_journal_entry_id IS NOT NULL
    )
    SELECT
      jl.vat_type AS raw_vat_type,
      COALESCE(jl.vat_type, 'zero_rated') AS vat_type,
      COALESCE(SUM(jl.credit - jl.debit), 0) AS base,
      COALESCE(SUM(CASE WHEN te.id IS NOT NULL THEN jl.credit - jl.debit ELSE 0 END), 0) AS base_on_taxed,
      COALESCE(SUM(CASE WHEN te.has_capital AND NOT te.has_other THEN jl.credit - jl.debit ELSE 0 END), 0) AS base_on_capital,
      COALESCE(SUM(CASE WHEN te.has_capital AND te.has_other THEN jl.credit - jl.debit ELSE 0 END), 0) AS base_on_mixed
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    LEFT JOIN taxed_entries te ON te.id = jl.journal_entry_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date >= ${periodStart}::DATE
      AND je.entry_date <= ${periodEnd}::DATE
      AND ga.account_type = 'revenue'
      AND je.id NOT IN (SELECT id FROM cancelled_entries)
      AND (
        jl.vat_type = ANY(${NIL_RATED_TYPES as string[]}::TEXT[])
        OR (jl.vat_type IS NULL AND je.id IN (SELECT id FROM untaxed_documents))
      )
    GROUP BY jl.vat_type
  `) as DbRow[];

  let zeroRated = 0;
  let exported = 0;
  let exempt = 0;
  let onTaxedJournals = 0;
  let onTaxedCapital = 0;
  let onTaxedAmbiguous = 0;
  let uncodedAssumedZeroRated = 0;
  for (const row of rows) {
    const vatType = String(row.vat_type ?? '');
    const base = Number(row.base) || 0;
    if (ZERO_RATED_TYPES.includes(vatType)) {
      zeroRated += base;
      if (vatType === EXPORT_TYPE) exported += base;
    } else if (EXEMPT_TYPES.includes(vatType)) exempt += base;
    else continue;
    onTaxedJournals += Number(row.base_on_taxed) || 0;
    onTaxedCapital += Number(row.base_on_capital) || 0;
    onTaxedAmbiguous += Number(row.base_on_mixed) || 0;
    if (row.raw_vat_type == null) uncodedAssumedZeroRated += base;
  }

  return {
    zeroRated: r2(zeroRated), exported: r2(exported), exempt: r2(exempt), onTaxedJournals: r2(onTaxedJournals),
    onTaxedCapital: r2(onTaxedCapital), onTaxedAmbiguous: r2(onTaxedAmbiguous),
    uncodedAssumedZeroRated: r2(uncodedAssumedZeroRated),
  };
}
