/**
 * Evidence Graph Service
 * DB-read-only service that joins GL entries/lines back to captured documents.
 * Provides the drill-through data for PRD-05 Phase 2 evidence UI.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface AccountEvidenceRow {
  jeId: string;
  entryDate: string;
  entryNumber: string;
  description: string | null;
  debit: number;
  credit: number;
  postingAgent: string | null;
  extractionConfidence: number | null;
  sourceDocumentId: string | null;
  documentVendor: string | null;
  documentReference: string | null;
  documentDate: string | null;
  documentThumbnailUrl: string | null;
  // PRD-06 Phase 1: AR-side drill-through. When the JE is backed by a
  // customer_invoice with a sealed PDF snapshot, surface the invoice id so the
  // client can fetch the exact bytes via GET /ar/invoice/[id]/pdf.
  customerInvoiceId: string | null;
  sealedPdfUrl: string | null;
}

export interface JeLineDetail {
  id: string;
  glAccountId: string;
  glAccountName: string;
  debit: number;
  credit: number;
  description: string | null;
  sourceDocumentLineId: string | null;
}

export interface CapturedDocumentRow {
  id: string;
  vendorName: string | null;
  documentDate: string | null;
  referenceNumber: string | null;
  totalAmount: number | null;
  vatAmount: number | null;
  status: string | null;
}

export interface JeEvidenceDetail {
  je: {
    id: string;
    entryNumber: string;
    entryDate: string;
    description: string | null;
    source: string | null;
    postingAgent: string | null;
    extractionConfidence: number | null;
    sourceDocumentId: string | null;
    sourceDocumentHash: string | null;
  };
  lines: JeLineDetail[];
  document: CapturedDocumentRow | null;
  // PRD-06 Phase 1: AR sealed-snapshot pointer, if the JE came from an invoice.
  customerInvoiceId: string | null;
  sealedPdfUrl: string | null;
}

// ---------------------------------------------------------------------------
// resolveAccountEvidence
// ---------------------------------------------------------------------------

export async function resolveAccountEvidence(
  companyId: string,
  glAccountId: string,
  opts?: { fromDate?: string; toDate?: string; limit?: number; costCentreId?: string; businessUnitId?: string },
): Promise<AccountEvidenceRow[]> {
  const limit = opts?.limit ?? 100;
  const cc = opts?.costCentreId ?? null;
  const bu = opts?.businessUnitId ?? null;
  const fromDate = opts?.fromDate ?? null;
  const toDate = opts?.toDate ?? null;

  try {
    const rows = (await sql`
      SELECT
        je.id                       AS je_id,
        je.entry_date               AS entry_date,
        je.entry_number             AS entry_number,
        je.description              AS description,
        COALESCE(jl.debit,  0)      AS debit,
        COALESCE(jl.credit, 0)      AS credit,
        je.posting_agent            AS posting_agent,
        je.extraction_confidence    AS extraction_confidence,
        -- Prefer the AR snapshot when this JE is backed by a customer invoice
        -- that has a sealed PDF; otherwise fall back to the JE's own link.
        COALESCE(ci.source_document_id, je.source_document_id) AS source_document_id,
        COALESCE(cd_ar.vendor_name,       cd.vendor_name)      AS document_vendor,
        COALESCE(cd_ar.reference_number,  cd.reference_number) AS document_reference,
        COALESCE(cd_ar.document_date,     cd.document_date)    AS document_date,
        ci.id                       AS customer_invoice_id,
        ci.invoice_number           AS customer_invoice_number,
        NULL::TEXT                  AS document_thumbnail_url
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      LEFT JOIN captured_documents cd
             ON cd.id = je.source_document_id
            AND cd.company_id = ${companyId}::uuid
      LEFT JOIN customer_invoices ci
             ON ci.gl_journal_entry_id = je.id
            AND ci.company_id = ${companyId}::uuid
      LEFT JOIN captured_documents cd_ar
             ON cd_ar.id = ci.source_document_id
            AND cd_ar.company_id = ${companyId}::uuid
      WHERE jl.company_id  = ${companyId}::uuid
        AND je.company_id  = ${companyId}::uuid
        AND jl.gl_account_id = ${glAccountId}::uuid
        AND je.status = 'posted'
        AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
          OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
        AND (${bu}::uuid IS NULL OR jl.business_unit_id = ${bu}::uuid)
        AND (${fromDate}::date IS NULL OR je.entry_date >= ${fromDate}::date)
        AND (${toDate}::date   IS NULL OR je.entry_date <= ${toDate}::date)
      ORDER BY je.entry_date DESC
      LIMIT ${limit}
    `) as Row[];

    return rows.map(r => {
      const customerInvoiceId = r.customer_invoice_id != null ? String(r.customer_invoice_id) : null;
      // The sealed PDF is always served via the AR endpoint, which handles
      // auth + falls back to on-demand render for legacy invoices.
      const sealedPdfUrl = customerInvoiceId
        ? `/api/accounting/ar/invoice/${customerInvoiceId}/pdf`
        : null;

      return {
        jeId:                  String(r.je_id),
        entryDate:             String(r.entry_date),
        entryNumber:           String(r.entry_number),
        description:           r.description != null ? String(r.description) : null,
        debit:                 Number(r.debit),
        credit:                Number(r.credit),
        postingAgent:          r.posting_agent != null ? String(r.posting_agent) : null,
        extractionConfidence:  r.extraction_confidence != null ? Number(r.extraction_confidence) : null,
        sourceDocumentId:      r.source_document_id != null ? String(r.source_document_id) : null,
        documentVendor:        r.document_vendor != null ? String(r.document_vendor) : null,
        documentReference:     r.document_reference != null ? String(r.document_reference) : null,
        documentDate:          r.document_date != null ? String(r.document_date) : null,
        documentThumbnailUrl:  null,
        customerInvoiceId,
        sealedPdfUrl,
      };
    });
  } catch (err) {
    log.error('resolveAccountEvidence failed', { companyId, glAccountId, err }, 'evidence-graph');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// resolveJournalEntryEvidence
// ---------------------------------------------------------------------------

export async function resolveJournalEntryEvidence(
  companyId: string,
  jeId: string,
): Promise<JeEvidenceDetail | null> {
  try {
    const [jeRow] = (await sql`
      SELECT
        id, entry_number, entry_date, description, source,
        posting_agent, extraction_confidence,
        source_document_id, source_document_hash
      FROM gl_journal_entries
      WHERE id = ${jeId}::uuid
        AND company_id = ${companyId}::uuid
    `) as Row[];

    if (!jeRow) return null;

    const lineRows = (await sql`
      SELECT
        jl.id,
        jl.gl_account_id,
        ga.account_name   AS gl_account_name,
        COALESCE(jl.debit,  0) AS debit,
        COALESCE(jl.credit, 0) AS credit,
        jl.description,
        jl.source_document_line_id
      FROM gl_journal_lines jl
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.journal_entry_id = ${jeId}::uuid
        AND jl.company_id = ${companyId}::uuid
      ORDER BY jl.id
    `) as Row[];

    // Look for a customer_invoice that points to this JE — gives us the AR
    // snapshot pointer, which we prefer over je.source_document_id.
    const [arLink] = (await sql`
      SELECT ci.id, ci.source_document_id
      FROM customer_invoices ci
      WHERE ci.gl_journal_entry_id = ${jeId}::uuid
        AND ci.company_id = ${companyId}::uuid
      LIMIT 1
    `) as Row[];

    const customerInvoiceId = arLink?.id ? String(arLink.id) : null;
    const effectiveDocId = arLink?.source_document_id
      ? String(arLink.source_document_id)
      : jeRow.source_document_id
        ? String(jeRow.source_document_id)
        : null;

    let document: CapturedDocumentRow | null = null;
    if (effectiveDocId) {
      const [docRow] = (await sql`
        SELECT id, vendor_name, document_date, reference_number,
               total_amount, vat_amount, status
        FROM captured_documents
        WHERE id = ${effectiveDocId}::uuid
          AND company_id = ${companyId}::uuid
      `) as Row[];

      if (docRow) {
        document = {
          id:              String(docRow.id),
          vendorName:      docRow.vendor_name != null ? String(docRow.vendor_name) : null,
          documentDate:    docRow.document_date != null ? String(docRow.document_date) : null,
          referenceNumber: docRow.reference_number != null ? String(docRow.reference_number) : null,
          totalAmount:     docRow.total_amount != null ? Number(docRow.total_amount) : null,
          vatAmount:       docRow.vat_amount != null ? Number(docRow.vat_amount) : null,
          status:          docRow.status != null ? String(docRow.status) : null,
        };
      }
    }

    const sealedPdfUrl = customerInvoiceId
      ? `/api/accounting/ar/invoice/${customerInvoiceId}/pdf`
      : null;

    return {
      je: {
        id:                   String(jeRow.id),
        entryNumber:          String(jeRow.entry_number),
        entryDate:            String(jeRow.entry_date),
        description:          jeRow.description != null ? String(jeRow.description) : null,
        source:               jeRow.source != null ? String(jeRow.source) : null,
        postingAgent:         jeRow.posting_agent != null ? String(jeRow.posting_agent) : null,
        extractionConfidence: jeRow.extraction_confidence != null ? Number(jeRow.extraction_confidence) : null,
        sourceDocumentId:     jeRow.source_document_id != null ? String(jeRow.source_document_id) : null,
        sourceDocumentHash:   jeRow.source_document_hash != null ? String(jeRow.source_document_hash) : null,
      },
      lines: lineRows.map(r => ({
        id:                   String(r.id),
        glAccountId:          String(r.gl_account_id),
        glAccountName:        String(r.gl_account_name),
        debit:                Number(r.debit),
        credit:               Number(r.credit),
        description:          r.description != null ? String(r.description) : null,
        sourceDocumentLineId: r.source_document_line_id != null ? String(r.source_document_line_id) : null,
      })),
      document,
      customerInvoiceId,
      sealedPdfUrl,
    };
  } catch (err) {
    log.error('resolveJournalEntryEvidence failed', { companyId, jeId, err }, 'evidence-graph');
    throw err;
  }
}
