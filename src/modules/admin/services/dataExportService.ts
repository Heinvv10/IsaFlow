/**
 * Data Export Service
 * Exports all major accounting data for a company as structured JSON.
 * Future enhancement: ZIP/CSV generation.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
type Row = Record<string, unknown>;

export interface CompanyExportResult {
  filename: string;
  data: Record<string, unknown[]>;
}


function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v as string;
}

function normalizeRows(rows: Row[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = v instanceof Date ? toIso(v) : v;
    }
    return out;
  });
}

export async function exportCompanyData(
  companyId: string
): Promise<CompanyExportResult> {
  try {
    const [companyRows, accountRows, customerRows, supplierRows, invoiceRows, journalRows, bankRows] =
      await Promise.all([
        sql`SELECT * FROM companies WHERE id = ${companyId}`,

        sql`SELECT * FROM gl_accounts
            WHERE company_id = ${companyId}
            ORDER BY code`,

        sql`SELECT * FROM customers
            WHERE company_id = ${companyId}
            ORDER BY name`,

        sql`SELECT * FROM suppliers
            WHERE company_id = ${companyId}
            ORDER BY name`,

        sql`SELECT * FROM invoices
            WHERE company_id = ${companyId}
            ORDER BY invoice_date DESC`,

        sql`SELECT * FROM gl_journal_entries
            WHERE company_id = ${companyId}
            ORDER BY entry_date DESC`,

        sql`SELECT * FROM bank_transactions
            WHERE company_id = ${companyId}
            ORDER BY transaction_date DESC`,
      ]);

    const companyName =
      (companyRows[0]?.name as string | undefined) ?? companyId;

    const dateStr = new Date().toISOString().split('T')[0];
    const safeName = companyName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
    const filename = `export-${safeName}-${dateStr}.json`;

    return {
      filename,
      data: {
        company:         normalizeRows(companyRows),
        accounts:        normalizeRows(accountRows),
        customers:       normalizeRows(customerRows),
        suppliers:       normalizeRows(supplierRows),
        invoices:        normalizeRows(invoiceRows),
        journal_entries: normalizeRows(journalRows),
        bank_transactions: normalizeRows(bankRows),
      },
    };
  } catch (err) {
    log.error('exportCompanyData failed', { companyId, error: err }, 'dataExportService');
    throw err;
  }
}
