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
}

// ---------------------------------------------------------------------------
// resolveAccountEvidence
// ---------------------------------------------------------------------------

export async function resolveAccountEvidence(
  companyId: string,
  glAccountId: string,
  opts?: { fromDate?: string; toDate?: string; limit?: number },
): Promise<AccountEvidenceRow[]> {
  const limit = opts?.limit ?? 100;
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
        je.source_document_id       AS source_document_id,
        cd.vendor_name              AS document_vendor,
        cd.reference_number         AS document_reference,
        cd.document_date            AS document_date,
        NULL::TEXT                  AS document_thumbnail_url
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      LEFT JOIN captured_documents cd
             ON cd.id = je.source_document_id
            AND cd.company_id = ${companyId}::uuid
      WHERE jl.company_id  = ${companyId}::uuid
        AND je.company_id  = ${companyId}::uuid
        AND jl.gl_account_id = ${glAccountId}::uuid
        AND je.status = 'posted'
        AND (${fromDate}::date IS NULL OR je.entry_date >= ${fromDate}::date)
        AND (${toDate}::date   IS NULL OR je.entry_date <= ${toDate}::date)
      ORDER BY je.entry_date DESC
      LIMIT ${limit}
    `) as Row[];

    return rows.map(r => ({
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
    }));
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

    let document: CapturedDocumentRow | null = null;
    if (jeRow.source_document_id) {
      const [docRow] = (await sql`
        SELECT id, vendor_name, document_date, reference_number,
               total_amount, vat_amount, status
        FROM captured_documents
        WHERE id = ${jeRow.source_document_id}::uuid
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
    };
  } catch (err) {
    log.error('resolveJournalEntryEvidence failed', { companyId, jeId, err }, 'evidence-graph');
    throw err;
  }
}
