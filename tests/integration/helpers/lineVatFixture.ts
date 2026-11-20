/**
 * Helpers for the per-line VAT suites (migration 1008): type an invoice's stored lines directly (no writer sets
 * vat_type yet) and read a journal's legs with their VAT codes. Built on lineRevenueFixture; disposable databases only.
 */
import { sql } from '@/lib/neon';
import type { LineRevenueFixture } from './lineRevenueFixture';

export type Leg = { code: string; debit: number; credit: number; project: string | null; vat: string | null };
export const L = (code: string, debit: number, credit: number, extra: Partial<Leg> = {}): Leg =>
  ({ code, debit, credit, project: null, vat: null, ...extra });

/** A journal's legs, ordered by account code, job, debit, credit. */
export async function journalLegs(f: LineRevenueFixture, journalId: string): Promise<Leg[]> {
  const rows = (await sql`
    SELECT a.account_code AS code, jl.debit, jl.credit, jl.project_id, jl.vat_type
    FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
    WHERE jl.journal_entry_id = ${journalId}::UUID AND jl.company_id = ${f.fx.companyId}::UUID
    ORDER BY a.account_code, jl.project_id NULLS FIRST, jl.debit, jl.credit`) as Record<string, unknown>[];
  return rows.map((r) => ({
    code: String(r.code), debit: Number(r.debit), credit: Number(r.credit),
    project: r.project_id ? String(r.project_id) : null, vat: r.vat_type ? String(r.vat_type) : null,
  }));
}

/**
 * Stores each named line's VAT type and tax_amount (by description), as a per-line writer will. `header.tax`, when
 * given, becomes the invoice's tax_amount and its total subtotal + tax (a ZAR invoice: functional_total alike).
 */
export async function typeLines(
  invoiceId: string, lines: Record<string, [string, number]>, header: { tax?: number } = {},
): Promise<void> {
  for (const [description, [vatType, tax]] of Object.entries(lines)) {
    await sql`UPDATE customer_invoice_items SET vat_type = ${vatType}, tax_amount = ${tax}
              WHERE invoice_id = ${invoiceId}::UUID AND description = ${description}`;
  }
  if (header.tax !== undefined) {
    await sql`UPDATE customer_invoices
              SET tax_amount = ${header.tax}, total_amount = subtotal + ${header.tax}::NUMERIC,
                  functional_total = subtotal + ${header.tax}::NUMERIC
              WHERE id = ${invoiceId}::UUID`;
  }
}
