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

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import type { JournalLineInput } from '../../types/gl.types';
import { BALANCE_DERIVED } from '../ar/invoiceStatusRecompute';
import { lockSupplierInvoiceForUpdate } from '../ap/supplierInvoiceLock';

type Row = DbRow;

const DEFAULT_VAT_RATE = 0.15; // SA VAT rate

/** Load VAT rate from app_settings, falling back to 15% */
async function getVatRate(companyId: string): Promise<number> {
  try {
    const rows = (await sql`
      SELECT value FROM app_settings
      WHERE key = 'vat_rate' AND company_id = ${companyId}::UUID
    `) as Row[];
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
 *
 * Approved bills only — approved, partially_paid or paid. The allow-list is
 * BALANCE_DERIVED (posted documents), shared with AR, so it also names
 * 'sent'/'overdue', which the supplier_invoices status check never admits. Not
 * FIFO_ELIGIBLE_STATUSES: that is "where cash may land" and may narrow for cash
 * reasons. A draft's figures can still change under the journal, and nothing
 * re-runs DRC on an `is_drc` bill to correct it. The row lock serialises two concurrent calls
 * so the second sees `is_drc` and refuses. Everything runs in one savepoint:
 * the route turns any throw into a 400, which `withAuth` COMMITS, so without
 * it a failure after `createJournalEntry` left an orphan draft journal.
 */
export async function applyDRCVat(companyId: string,
  supplierInvoiceId: string,
  userId: string
): Promise<DRCResult> {
  return withSavepoint('drc_vat_apply', () => applyDRCVatInner(companyId, supplierInvoiceId, userId));
}

async function applyDRCVatInner(
  companyId: string,
  supplierInvoiceId: string,
  userId: string,
): Promise<DRCResult> {
  const inv = await lockSupplierInvoiceForUpdate(companyId, supplierInvoiceId);
  // One reply for absent, foreign and soft-deleted: no existence oracle. The
  // lock is held through the post on purpose — released earlier, a second
  // call could read is_drc = false again.
  if (!inv || inv.deleted_at) throw new Error('Supplier invoice not found');

  if (inv.is_drc) throw new Error('DRC VAT already applied to this invoice');
  const status = String(inv.status);
  if (!BALANCE_DERIVED.includes(status)) {
    throw new Error(
      `DRC VAT can only be applied to an approved supplier invoice; ${String(inv.invoice_number)} is ${status}.`,
    );
  }
  // A reverse-charge invoice carries no supplier VAT. Approval already posted
  // DR Input VAT = tax_amount, so DRC's own DR Input VAT would claim it twice.
  // Any non-zero figure, negative included: the eligible list admits exactly
  // tax_amount = 0, and the two must never disagree.
  const supplierVat = Number(inv.tax_amount ?? 0);
  if (supplierVat !== 0) {
    throw new Error(
      `DRC VAT applies only to a bill on which the supplier charged no VAT; ${String(inv.invoice_number)} `
      + `carries R${supplierVat.toFixed(2)} VAT, already claimed as input VAT when it was approved, so DRC `
      + 'would claim it twice. If the supplier should not have charged VAT, correct the bill first '
      + '(cancel and re-enter it without VAT).',
    );
  }

  // DRC VAT is calculated on the pre-VAT base (subtotal), not the gross total
  const totalExclVat = Number(inv.subtotal);
  const vatRate = await getVatRate(companyId);
  const vatAmount = Math.round(totalExclVat * vatRate * 100) / 100;

  // Get VAT account IDs by subtype (code-independent)
  const inputVatId = await getSystemAccountId('vat_input', companyId);
  const outputVatId = await getSystemAccountId('vat_output', companyId);

  const description = `DRC VAT: ${inv.invoice_number} (R${vatAmount.toFixed(2)})`;

  const lines: JournalLineInput[] = [
    { glAccountId: String(inputVatId), debit: vatAmount, credit: 0, description },
    { glAccountId: String(outputVatId), debit: 0, credit: vatAmount, description },
  ];

  const je = await createJournalEntry(companyId, {
    entryDate: new Date().toISOString().split('T')[0] ?? '',
    description,
    source: 'auto_vat_adjustment',
    // source_record_id, NOT source_document_id: the latter FKs to
    // captured_documents (migration 409) and a supplier invoice id throws on it.
    sourceRecordId: supplierInvoiceId,
    lines,
  }, userId);

  await postJournalEntry(companyId, je.id, userId);

  // Mark invoice as DRC processed
  await sql`
    UPDATE supplier_invoices SET is_drc = true WHERE id = ${supplierInvoiceId}::UUID AND company_id = ${companyId}
  `;

  log.info('Applied DRC VAT', {
    supplierInvoiceId, vatAmount, journalEntryId: je.id,
  }, 'accounting');

  return { supplierInvoiceId, vatAmount, journalEntryId: je.id };
}

/**
 * Get all DRC-eligible supplier invoices (not yet processed).
 */
export async function getDRCEligibleInvoices(companyId: string): Promise<Array<{
  id: string; invoiceNumber: string; supplierName: string;
  totalAmount: number; vatAmount: number; invoiceDate: string;
}>> {
  const rows = (await sql`
    SELECT si.id, si.invoice_number, si.subtotal, si.total_amount, si.invoice_date,
           s.company_name as supplier_name
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.company_id = ${companyId}
      AND si.status = ANY(${BALANCE_DERIVED}::TEXT[])
      AND si.deleted_at IS NULL
      AND COALESCE(si.tax_amount, 0) = 0
      AND (si.is_drc IS NULL OR si.is_drc = false)
    ORDER BY si.invoice_date DESC
  `) as Row[];

  const vatRate = await getVatRate(companyId);
  return rows.map((r: Row) => ({
    id: String(r.id),
    invoiceNumber: String(r.invoice_number),
    supplierName: String(r.supplier_name || 'Unknown'),
    totalAmount: Number(r.total_amount),
    vatAmount: Math.round(Number(r.subtotal) * vatRate * 100) / 100,
    invoiceDate: String(r.invoice_date).split('T')[0] ?? '',
  }));
}

/**
 * Get DRC VAT history (already processed).
 */
export async function getDRCHistory(companyId: string): Promise<Array<{
  id: string; invoiceNumber: string; supplierName: string;
  totalAmount: number; invoiceDate: string;
}>> {
  const rows = (await sql`
    SELECT si.id, si.invoice_number, si.total_amount, si.invoice_date,
           s.company_name as supplier_name
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.company_id = ${companyId} AND si.is_drc = true
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
