/**
 * The documents accepting a message creates in the RECEIVER's company (P2): a DRAFT supplier invoice (an invoice message) or a
 * DRAFT supplier credit note (a credit-note message), through the receiver's own services (`createSupplierInvoice`,
 * `createCreditNote`) in its own transaction, so every rule of a bill (account guard, dimension rules, duplicate fingerprint)
 * applies. The draft carries the sender's number, date, lines and VAT to the cent (the receiver's lines are written with the
 * sender's own line VAT, `trustSourceTax`, because re-deriving it from a rate moves a total by cents).
 * Nothing is approved or posted here: a person approves the draft in the usual way.
 *
 * The sender's sealed PDF is copied as the bill's supporting document, best effort: the bytes are read ONLY from under the
 * SENDER's own storage prefix (`downloadCapturedDocument` refuses any path outside it), must hash to what the message says, and
 * are stored under the RECEIVER's prefix. A copy that fails leaves the draft without it (logged, reported to the caller).
 */
import crypto from 'node:crypto';
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  CAPTURED_DOCS_BUCKET, CUSTOMER_INVOICES_BUCKET, downloadCapturedDocument, removeCapturedDocument, uploadCapturedDocument,
} from '@/lib/supabaseStorage';
import { createSupplierInvoice } from '../ap/supplierInvoiceService';
import { createCreditNote } from '../ar/creditNoteService';
import type { SupplierInvoiceImportInput } from '../../types/ap.types';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import type { AcceptSide } from './acceptContext';
import type { MirrorPayload } from './mirrorPayload';

export interface DraftOptions {
  actor?: PostingActorOpts;
  /** Made by the auto-accept worker: the draft says so (the user it is created under is only the receiver's write-role user it acts as). */
  auto?: boolean;
}

/** The draft supplier invoice for an invoice message: one line per sender line, on the chosen accounts. */
export async function createDraftBill(
  companyId: string, userId: string, side: AcceptSide, payload: MirrorPayload, accountByLine: string[], opts: DraftOptions,
): Promise<string> {
  const input: SupplierInvoiceImportInput = {
    trustSourceTax: true,
    invoiceNumber: payload.number,
    supplierId: side.supplierId!,
    invoiceDate: payload.date,
    ...(payload.dueDate ? { dueDate: payload.dueDate, dueDateGivenAs: 'document' as const } : {}),
    currencyCode: 'ZAR',
    exchangeRate: 1,
    reference: `${opts.auto ? 'Intercompany auto-accept' : 'Intercompany'}: ${payload.senderName}`.slice(0, 255),
    notes: [opts.auto ? 'Created by intercompany auto-accept.' : null, payload.notes].filter(Boolean).join(' ') || undefined,
    items: payload.lines.map((l, i) => ({
      description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, taxAmount: l.taxAmount,
      glAccountId: accountByLine[i]!,
      ...(side.defaultCc1Id ? { cc1Id: side.defaultCc1Id } : {}),
      ...(side.defaultCc2Id ? { cc2Id: side.defaultCc2Id } : {}),
      ...(side.defaultBuId ? { buId: side.defaultBuId } : {}),
    })),
  };
  const bill = await createSupplierInvoice(companyId, input, userId, opts.actor);
  return bill.id;
}

/** The draft supplier credit note for a credit-note message, on the chosen account, with the sender's exact VAT. */
export async function createDraftSupplierCreditNote(
  companyId: string, userId: string, side: AcceptSide, payload: MirrorPayload, accountId: string, opts: DraftOptions,
): Promise<string> {
  const detail = [
    `Intercompany credit note ${payload.number} from ${payload.senderName}${opts.auto ? ' (created by intercompany auto-accept)' : ''}`,
    payload.creditsInvoiceNumber ? `crediting invoice ${payload.creditsInvoiceNumber}` : null,
    payload.notes,
  ].filter(Boolean).join('. ');
  const note = await createCreditNote(companyId, {
    type: 'supplier', supplierId: side.supplierId!, creditDate: payload.date, reason: detail.slice(0, 2000),
    subtotal: payload.subtotal, taxRate: payload.lines[0]?.taxRate ?? 15, taxAmount: payload.taxAmount,
    glAccountId: accountId,
    ...(side.defaultCc1Id ? { cc1Id: side.defaultCc1Id } : {}),
    ...(side.defaultCc2Id ? { cc2Id: side.defaultCc2Id } : {}),
    ...(side.defaultBuId ? { buId: side.defaultBuId } : {}),
  }, userId, opts.actor);
  return note.id;
}

/**
 * Copy the sender's sealed PDF onto the new bill as its supporting document. Returns whether it was copied. Never throws: a
 * missing or altered file, or a storage fault, leaves the draft without a document (the bytes were not the sender's say-so).
 */
export async function copySenderPdf(
  companyId: string, senderCompanyId: string, userId: string, billId: string, number: string, pdf: NonNullable<MirrorPayload['pdf']>,
): Promise<{ copied: boolean; storagePath: string | null }> {
  let storagePath: string | null = null;
  try {
    const bytes = await downloadCapturedDocument(CUSTOMER_INVOICES_BUCKET, pdf.path, senderCompanyId);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== pdf.sha256) {
      log.warn('Intercompany PDF not copied: it does not match its hash', { companyId, billId }, 'intercompany');
      return { copied: false, storagePath: null };
    }
    const docId = crypto.randomUUID();
    await withSavepoint('intercompany_pdf_copy', async () => {
      await sql`
        INSERT INTO captured_documents (
          id, company_id, file_name, file_type, file_size, document_type, status, document_category, notes,
          uploaded_by, raw_bytes_sha256, raw_bytes_size, matched_invoice_id
        ) VALUES (
          ${docId}::UUID, ${companyId}::UUID, ${`${number}.pdf`.slice(0, 200)}, 'pdf', ${bytes.length}, 'invoice', 'matched', 'invoice',
          'Copied from the sending company (intercompany)', ${userId}::UUID, ${hash}, ${bytes.length}, ${billId}::UUID
        )
      `;
      const { path } = await uploadCapturedDocument(companyId, docId, bytes, 'application/pdf');
      storagePath = path;
      await sql`UPDATE captured_documents SET storage_bucket = ${CAPTURED_DOCS_BUCKET}, storage_path = ${path} WHERE id = ${docId}::UUID AND company_id = ${companyId}::UUID`;
      await sql`UPDATE supplier_invoices SET source_document_id = ${docId}::UUID WHERE id = ${billId}::UUID AND company_id = ${companyId}::UUID`;
    });
    return { copied: true, storagePath };
  } catch (err) {
    log.warn('Intercompany PDF not copied', { companyId, billId, error: err instanceof Error ? err.name : 'unknown' }, 'intercompany');
    // The file may already be stored when a later statement failed: take it back (best effort), so no orphan is left under the receiver's prefix.
    if (storagePath) await discardUploaded(companyId, storagePath);
    return { copied: false, storagePath: null };
  }
}

/** Best effort: remove a file this company's accept stored but did not keep (the accept failed after the upload). Never throws. */
export async function discardUploaded(companyId: string, storagePath: string): Promise<void> {
  try {
    await removeCapturedDocument(CAPTURED_DOCS_BUCKET, storagePath, companyId);
  } catch (err) {
    log.error('Intercompany: an uploaded PDF could not be removed after a failed accept', { companyId, error: err instanceof Error ? err.name : 'unknown' }, 'intercompany');
  }
}
