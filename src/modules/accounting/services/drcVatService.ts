/**
 * DRC (Domestic Reverse Charge) VAT Service
 * Phase 5: Handle DRC VAT for supplier invoices
 *
 * DRC applies when a supplier provides certain services and the recipient
 * (FibreFlow) is responsible for accounting for VAT on those supplies.
 * Instead of the supplier charging VAT, the buyer self-accounts:
 *   DR Input VAT (1140)   — claimable
 *   CR Output VAT (2120)  — payable (net effect = zero)
 *
 * The invoice amount stays the same but both sides of VAT are recorded.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import type { JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const DEFAULT_VAT_RATE = 0.15; // SA VAT rate
const VAT_INPUT_CODE = '1140';
const VAT_OUTPUT_CODE = '2120';

/** Load VAT rate from app_settings, falling back to 15% */
async function getVatRate(): Promise<number> {
  try {
    const rows = (await sql`SELECT value FROM app_settings WHERE key = 'vat_rate'`) as Row[];
    if (rows[0]?.value) {
      const rate = Number(rows[0].value);
      if (rate > 0 && rate < 1) return rate;
    }
  } catch (error) { log.warn('Failed to fetch VAT rate from DB, using default', { error }, 'drcVatService'); }
  return DEFAULT_VAT_RATE;
}

export interface DRCResult {
  supplierInvoiceId: string;
  vatAmount: number;
  journalEntryId: string;
}

/**
 * Apply DRC VAT to a supplier invoice.
 * Creates a journal entry: DR Input VAT, CR Output VAT.
 */
export async function applyDRCVat(
  supplierInvoiceId: string,
  userId: string
): Promise<DRCResult> {
  // Get invoice details
  const invoices = (await sql`
    SELECT si.id, si.invoice_number, si.total_amount, si.is_drc
    FROM supplier_invoices si
    WHERE si.id = ${supplierInvoiceId}::UUID
  `) as Row[];

  if (!invoices[0]) throw new Error('Supplier invoice not found');
  const inv = invoices[0];

  if (inv.is_drc) throw new Error('DRC VAT already applied to this invoice');

  const totalExclVat = Number(inv.total_amount);
  const vatRate = await getVatRate();
  const vatAmount = Math.round(totalExclVat * vatRate * 100) / 100;

  // Get VAT account IDs
  const accounts = (await sql`
    SELECT id, account_code FROM gl_accounts
    WHERE account_code IN (${VAT_INPUT_CODE}, ${VAT_OUTPUT_CODE})
  `) as Row[];

  const inputVatId = accounts.find((a: Row) => a.account_code === VAT_INPUT_CODE)?.id;
  const outputVatId = accounts.find((a: Row) => a.account_code === VAT_OUTPUT_CODE)?.id;

  if (!inputVatId || !outputVatId) {
    throw new Error('VAT GL accounts (1140/2120) not found in chart of accounts');
  }

  const description = `DRC VAT: ${inv.invoice_number} (R${vatAmount.toFixed(2)})`;

  const lines: JournalLineInput[] = [
    { glAccountId: String(inputVatId), debit: vatAmount, credit: 0, description },
    { glAccountId: String(outputVatId), debit: 0, credit: vatAmount, description },
  ];

  const je = await createJournalEntry({
    entryDate: new Date().toISOString().split('T')[0] ?? '',
    description,
    source: 'auto_vat_adjustment',
    sourceDocumentId: supplierInvoiceId,
    lines,
  }, userId);

  await postJournalEntry(je.id, userId);

  // Mark invoice as DRC processed
  await sql`
    UPDATE supplier_invoices SET is_drc = true WHERE id = ${supplierInvoiceId}::UUID
  `;

  log.info('Applied DRC VAT', {
    supplierInvoiceId, vatAmount, journalEntryId: je.id,
  }, 'accounting');

  return { supplierInvoiceId, vatAmount, journalEntryId: je.id };
}

/**
 * Get all DRC-eligible supplier invoices (not yet processed).
 */
export async function getDRCEligibleInvoices(): Promise<Array<{
  id: string; invoiceNumber: string; supplierName: string;
  totalAmount: number; vatAmount: number; invoiceDate: string;
}>> {
  const rows = (await sql`
    SELECT si.id, si.invoice_number, si.total_amount, si.invoice_date,
           s.company_name as supplier_name
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.status IN ('approved', 'partially_paid', 'paid')
      AND (si.is_drc IS NULL OR si.is_drc = false)
    ORDER BY si.invoice_date DESC
  `) as Row[];

  const vatRate = await getVatRate();
  return rows.map((r: Row) => ({
    id: String(r.id),
    invoiceNumber: String(r.invoice_number),
    supplierName: String(r.supplier_name || 'Unknown'),
    totalAmount: Number(r.total_amount),
    vatAmount: Math.round(Number(r.total_amount) * vatRate * 100) / 100,
    invoiceDate: String(r.invoice_date).split('T')[0] ?? '',
  }));
}

/**
 * Get DRC VAT history (already processed).
 */
export async function getDRCHistory(): Promise<Array<{
  id: string; invoiceNumber: string; supplierName: string;
  totalAmount: number; invoiceDate: string;
}>> {
  const rows = (await sql`
    SELECT si.id, si.invoice_number, si.total_amount, si.invoice_date,
           s.company_name as supplier_name
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.is_drc = true
    ORDER BY si.invoice_date DESC
  `) as Row[];

  return rows.map((r: Row) => ({
    id: String(r.id),
    invoiceNumber: String(r.invoice_number),
    supplierName: String(r.supplier_name || 'Unknown'),
    totalAmount: Number(r.total_amount),
    invoiceDate: String(r.invoice_date).split('T')[0] ?? '',
  }));
}
