/**
 * The revenue lines behind VAT201 fields 2, 2A and 3 (read-only drill-down).
 *
 * The same population `getNilRatedSupplies` sums: posted revenue legs inside the
 * period whose own VAT code is zero-rated, export or exempt, or that carry no
 * code on a document that raised no VAT; a cancelled document's journal is out.
 * A line is `credit - debit`, so a credit note nets off. The predicate is
 * restated here rather than imported because the aggregate has no row form; the
 * tie tests compare the two against hand-written cents.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

const CANCELLED_STATUSES: readonly string[] = ['cancelled', 'void', 'voided'];

export type NilRatedField = '2' | '2A' | '3';

export const NIL_RATED_FIELD_TYPES: Record<NilRatedField, readonly string[]> = {
  '2': ['zero_rated'],
  '2A': ['export'],
  '3': ['exempt', 'no_vat'],
};

export interface NilRatedDrillRow {
  lineId: string;
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  accountCode: string;
  accountName: string;
  /** The line's own code; null when it carried none and the document raised no VAT (assumed zero-rated). */
  vatType: string | null;
  /** credit - debit, rands. */
  amount: number;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Every line behind a nil-rated field, in date / entry / line order. */
export async function listNilRatedLines(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  field: NilRatedField,
): Promise<NilRatedDrillRow[]> {
  const types = NIL_RATED_FIELD_TYPES[field];
  const includeUncoded = field === '2';
  const rows = (await sql`
    WITH cancelled_entries AS (
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
    SELECT jl.id::TEXT AS line_id, je.id::TEXT AS journal_entry_id,
           COALESCE(je.entry_number, '') AS entry_number, je.entry_date::TEXT AS entry_date,
           ga.account_code, ga.account_name, jl.vat_type, (jl.credit - jl.debit) AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date >= ${periodStart}::DATE
      AND je.entry_date <= ${periodEnd}::DATE
      AND ga.account_type = 'revenue'
      AND je.id NOT IN (SELECT id FROM cancelled_entries)
      AND (
        jl.vat_type = ANY(${types as string[]}::TEXT[])
        OR (${includeUncoded}::BOOLEAN AND jl.vat_type IS NULL AND je.id IN (SELECT id FROM untaxed_documents))
      )
    ORDER BY je.entry_date, je.entry_number, jl.id
  `) as DbRow[];
  return rows.map((r) => ({
    lineId: String(r.line_id),
    journalEntryId: String(r.journal_entry_id),
    entryNumber: String(r.entry_number ?? ''),
    entryDate: String(r.entry_date).slice(0, 10),
    accountCode: String(r.account_code ?? ''),
    accountName: String(r.account_name ?? ''),
    vatType: r.vat_type == null ? null : String(r.vat_type),
    amount: r2(Number(r.amount) || 0),
  }));
}
