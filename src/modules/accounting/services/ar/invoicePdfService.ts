/**
 * Invoice PDF Service — re-export facade for backward compatibility.
 *
 * Domain logic lives in:
 *   pdfShared.ts            — formatting helpers, company details, branding
 *   invoicePdfBuilder.ts    — customer invoice PDF generation
 *   creditNotePdfBuilder.ts — credit note PDF generation
 */

export { generateInvoicePdf } from './invoicePdfBuilder';
export { generateCreditNotePdf } from './creditNotePdfBuilder';

// Re-export shared types for any consumers that import from this file
export type { CompanyDetails } from '../core/pdfShared';

import { sql } from '@/lib/neon';

/**
 * Build a human-readable filename for the downloaded invoice PDF, e.g.
 *   Invoice-INV0000133-Legare-Mining-Services.pdf
 * Falls back to "Invoice-<uuid>.pdf" if the lookup misses (defensive — the
 * caller already validated tenant scope, so this should never happen in
 * practice). Whitespace-only / non-alphanumeric chars are collapsed to
 * single dashes; max 64 chars per segment to keep the result OS-safe.
 */
export async function getInvoicePdfFilename(
  companyId: string,
  invoiceId: string,
): Promise<string> {
  const rows = (await sql`
    SELECT ci.invoice_number, c.name AS client_name
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
     WHERE ci.id = ${invoiceId}::UUID
       AND ci.company_id = ${companyId}::UUID
     LIMIT 1
  `) as Array<{ invoice_number: string | null; client_name: string | null }>;

  const slug = (s: string): string =>
    s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

  const r = rows[0];
  if (!r || !r.invoice_number) return `Invoice-${invoiceId}.pdf`;

  const number = slug(String(r.invoice_number));
  const client = r.client_name ? slug(String(r.client_name)) : '';
  return client ? `Invoice-${number}-${client}.pdf` : `Invoice-${number}.pdf`;
}
