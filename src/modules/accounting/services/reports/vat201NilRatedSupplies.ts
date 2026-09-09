/**
 * Zero-rated and exempt supply VALUES, from the documents that raise them.
 *
 * WHY THIS IS NOT DERIVED FROM THE LEDGER. `getVat201Report` builds a box only
 * from a VAT control leg: `vatBoxBasisQuery` selects a journal into the return
 * only when it posts to a `vat_input`/`vat_output` account (or carries a VAT
 * code on an account with no VAT treatment), and `deriveVatBoxes` attributes
 * base only to the VAT types its tax legs name. An export or an exempt supply
 * raises NO VAT, posts NO control leg, and is therefore invisible to that
 * basis — its journal is never even selected.
 *
 * Fields 2 and 3 of the VAT201 are compulsory disclosures. Reporting zero
 * turnover for them on a company with export sales misstates the return, so
 * they come from the invoices and credit notes instead, which is the only
 * population that records a nil-rated supply at all.
 *
 * Credit notes are included — their omission is the whole of audit K-031.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** Both spellings of a killed document are in use across AR and the credit notes. */
const CANCELLED_STATUSES: readonly string[] = ['cancelled', 'void', 'voided'];

const ZERO_RATED_TYPES: readonly string[] = ['zero_rated', 'export'];
const EXEMPT_TYPES: readonly string[] = ['exempt', 'no_vat'];

export interface NilRatedSupplies {
  /** Field 2 — zero-rated supplies, net of zero-rated credit notes. */
  zeroRated: number;
  /** Field 3 — exempt supplies, net of exempt credit notes. */
  exempt: number;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Sum the period's nil-rated customer supplies by VAT type.
 *
 * A document's VAT type is the first VAT code on its journal, ordered so the
 * choice is deterministic rather than whatever the heap returns, and falls back
 * to the tax rate when the journal carries no code at all. A document with BOTH
 * a taxed and a nil-rated line resolves to one type, the same single-type
 * assumption the invoice-derived VAT201 has always made; a mixed-rate document
 * is reported by the 15% tie-out rather than split here.
 */
export async function getNilRatedSupplies(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<NilRatedSupplies> {
  const rows = (await sql`
    WITH supplies AS (
      SELECT
        ci.subtotal AS base,
        COALESCE(
          (
            SELECT jl.vat_type FROM gl_journal_lines jl
            WHERE jl.journal_entry_id = ci.gl_journal_entry_id
              AND jl.company_id = ${companyId}::UUID
              AND jl.vat_type IS NOT NULL
            ORDER BY jl.vat_type
            LIMIT 1
          ),
          CASE WHEN COALESCE(ci.tax_rate, 0) = 0 THEN 'zero_rated' ELSE 'standard' END
        ) AS vat_type
      FROM customer_invoices ci
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.invoice_date >= ${periodStart}::DATE
        AND ci.invoice_date <= ${periodEnd}::DATE
        AND ci.status <> ALL(${CANCELLED_STATUSES as string[]}::TEXT[])
      UNION ALL
      SELECT
        -cn.subtotal AS base,
        COALESCE(
          (
            SELECT jl.vat_type FROM gl_journal_lines jl
            WHERE jl.journal_entry_id = cn.gl_journal_entry_id
              AND jl.company_id = ${companyId}::UUID
              AND jl.vat_type IS NOT NULL
            ORDER BY jl.vat_type
            LIMIT 1
          ),
          CASE WHEN COALESCE(cn.tax_amount, 0) = 0 THEN 'zero_rated' ELSE 'standard' END
        ) AS vat_type
      FROM credit_notes cn
      WHERE cn.company_id = ${companyId}::UUID
        AND cn.type = 'customer'
        AND cn.credit_date >= ${periodStart}::DATE
        AND cn.credit_date <= ${periodEnd}::DATE
        AND cn.status <> ALL(${CANCELLED_STATUSES as string[]}::TEXT[])
    )
    SELECT vat_type, COALESCE(SUM(base), 0) AS base
    FROM supplies
    GROUP BY vat_type
  `) as DbRow[];

  let zeroRated = 0;
  let exempt = 0;
  for (const row of rows) {
    const vatType = String(row.vat_type ?? '');
    const base = Number(row.base) || 0;
    if (ZERO_RATED_TYPES.includes(vatType)) zeroRated += base;
    else if (EXEMPT_TYPES.includes(vatType)) exempt += base;
  }

  return { zeroRated: r2(zeroRated), exempt: r2(exempt) };
}
