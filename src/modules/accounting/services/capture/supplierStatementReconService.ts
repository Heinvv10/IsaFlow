/**
 * Supplier Statement Reconciliation Service
 *
 * Orchestrates: fetch PDF bytes → VLM extraction → match lines → persist.
 *
 * DB queries:   supplierStatementReconDb.ts
 * Match logic:  supplierStatementMatchHelper.ts
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';
import { fetchRawBytes } from '@/lib/documentStorage';
import { extractSupplierStatementWithVlm } from '@/modules/accounting/services/bank/vlmSupplierStatementService';
import {
  buildInserts,
  toDateStr,
  toNum,
  toStr,
  type MismatchReason,
} from './supplierStatementMatchHelper';
import {
  fetchFullReconciliation,
  loadSupplierInvoices,
  persistLinesAndUpdateCounts,
} from './supplierStatementReconDb';

// ---------------------------------------------------------------------------
// Public types (re-imported by supplierStatementReconDb.ts to avoid circular)
// ---------------------------------------------------------------------------

export interface ReconciliationLine {
  id: string;
  reconciliationId: string;
  lineDate: string | null;
  reference: string | null;
  description: string | null;
  debit: number;
  credit: number;
  runningBalance: number | null;
  matchedSupplierInvoiceId: string | null;
  matchedInvoiceNumber: string | null;
  matchConfidence: number | null;
  mismatchReason: MismatchReason;
}

export interface MissingInvoice {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number;
}

export interface SupplierStatementReconciliation {
  id: string;
  companyId: string;
  supplierId: string;
  supplierName: string;
  sourceDocumentId: string;
  statementDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  supplierBalance: number;
  isaflowBalance: number;
  variance: number;
  status: 'unreconciled' | 'reconciled' | 'disputed' | 'archived';
  missingInIsaflowCount: number;
  missingInStatementCount: number;
  amountDiffCount: number;
  lines: ReconciliationLine[];
  missingInvoices: MissingInvoice[];
  createdAt: string;
  reconciledAt: string | null;
}

type DbRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createReconciliation(
  companyId: string,
  supplierId: string,
  capturedDocumentId: string,
  userId: string,
): Promise<SupplierStatementReconciliation> {
  const raw = await fetchRawBytes(capturedDocumentId, companyId);
  if (!raw) throw new Error(`Captured document ${capturedDocumentId} not found or has no stored bytes`);

  const base64 = raw.buffer.toString('base64');
  const mimeType = raw.fileType === 'pdf' ? 'application/pdf' : `image/${raw.fileType}`;
  const extraction = await extractSupplierStatementWithVlm(base64, mimeType);

  if (extraction.warnings.length > 0) {
    log.warn('Supplier statement extraction warnings', { warnings: extraction.warnings }, 'recon-service');
  }

  const statementDate = extraction.statementDate ?? asAtTodayStr();
  const supplierBalance = extraction.closingBalance ?? 0;

  // Our side of the variance is what we owed this supplier ON THE STATEMENT
  // DATE — the date the supplier's closing balance is struck at — from the AP
  // ageing's own rewind (R-059). It used to be today's si.balance over every
  // non-paid, non-cancelled bill, drafts included: a payment made after the
  // statement date showed as a variance the supplier could never explain, and
  // a bill raised after it was compared against a statement that predates it.
  const aged = await getAPAgingDetail(companyId, supplierId, statementDate);
  const isaflowBalance = Math.round(aged.invoices.reduce((s, inv) => s + inv.balance, 0) * 100) / 100;
  const variance = Math.round((supplierBalance - isaflowBalance) * 100) / 100;

  const [headerRow] = (await sql`
    INSERT INTO supplier_statement_reconciliations
      (company_id, supplier_id, source_document_id, statement_date,
       period_start, period_end, supplier_balance, isaflow_balance, variance,
       status, created_by)
    VALUES (
      ${companyId}, ${supplierId}::uuid, ${capturedDocumentId}::uuid, ${statementDate}::date,
      ${extraction.periodStart ?? null}::date, ${extraction.periodEnd ?? null}::date,
      ${supplierBalance}, ${isaflowBalance}, ${variance},
      'unreconciled', ${userId}::uuid
    )
    RETURNING id
  `) as DbRow[];
  if (!headerRow) throw new Error('Failed to insert reconciliation header');
  const reconId = headerRow.id as string;

  const invoices = await loadSupplierInvoices(
    companyId, supplierId, extraction.periodStart ?? null, extraction.periodEnd ?? null,
  );
  const { inserts, confidences } = buildInserts(reconId, extraction.lines, invoices);
  await persistLinesAndUpdateCounts(reconId, inserts);

  const exact = confidences.filter((c) => c === 1.0).length;
  const fuzzy = confidences.filter((c) => c === 0.85).length;
  log.info('Supplier statement match confidence distribution', {
    reconId, total: inserts.length, exact, fuzzy, unmatched: inserts.length - exact - fuzzy,
  }, 'recon-service');

  const result = await fetchFullReconciliation(companyId, reconId);
  if (!result) throw new Error('Failed to retrieve created reconciliation');
  return result;
}

export async function getReconciliation(
  companyId: string,
  reconciliationId: string,
): Promise<SupplierStatementReconciliation | null> {
  return fetchFullReconciliation(companyId, reconciliationId);
}

/**
 * List view: single JOIN query, no per-reconciliation round-trips.
 * `lines` and `missingInvoices` are returned empty — the list UI only renders
 * header fields + counts. Callers that need per-line data must call
 * getReconciliation(id) on click-through.
 */
export async function listReconciliations(
  companyId: string,
  supplierId?: string,
): Promise<SupplierStatementReconciliation[]> {
  const rows = (await sql`
    SELECT ssr.*, s.name AS supplier_name
    FROM supplier_statement_reconciliations ssr
    JOIN suppliers s ON s.id = ssr.supplier_id
    WHERE ssr.company_id = ${companyId}
      AND (${supplierId ?? null}::uuid IS NULL OR ssr.supplier_id = ${supplierId ?? null}::uuid)
    ORDER BY ssr.statement_date DESC, ssr.created_at DESC
    LIMIT 200
  `) as DbRow[];

  return rows.map((r): SupplierStatementReconciliation => ({
    id: r.id as string,
    companyId: r.company_id as string,
    supplierId: r.supplier_id as string,
    supplierName: String(r.supplier_name ?? ''),
    sourceDocumentId: r.source_document_id as string,
    statementDate: toDateStr(r.statement_date) ?? '',
    periodStart: toDateStr(r.period_start),
    periodEnd: toDateStr(r.period_end),
    supplierBalance: toNum(r.supplier_balance),
    isaflowBalance: toNum(r.isaflow_balance),
    variance: toNum(r.variance),
    status: (r.status as SupplierStatementReconciliation['status']) ?? 'unreconciled',
    missingInIsaflowCount: toNum(r.missing_in_isaflow_count),
    missingInStatementCount: toNum(r.missing_in_statement_count),
    amountDiffCount: toNum(r.amount_diff_count),
    lines: [],
    missingInvoices: [],
    createdAt: String(r.created_at ?? ''),
    reconciledAt: r.reconciled_at ? String(r.reconciled_at) : null,
  }));
}

export async function rematchLines(
  companyId: string,
  reconciliationId: string,
): Promise<SupplierStatementReconciliation> {
  const [header] = (await sql`
    SELECT * FROM supplier_statement_reconciliations
    WHERE id = ${reconciliationId}::uuid AND company_id = ${companyId}
  `) as DbRow[];
  if (!header) throw new Error(`Reconciliation ${reconciliationId} not found`);

  const existingLines = (await sql`
    SELECT * FROM supplier_statement_lines
    WHERE reconciliation_id = ${reconciliationId}::uuid
      AND mismatch_reason IS DISTINCT FROM 'missing_in_statement'
    ORDER BY line_date ASC NULLS FIRST, created_at ASC
  `) as DbRow[];

  const invoices = await loadSupplierInvoices(
    companyId,
    header.supplier_id as string,
    toDateStr(header.period_start),
    toDateStr(header.period_end),
  );

  const syntheticLines = existingLines.map((r) => ({
    date: toDateStr(r.line_date) ?? undefined,
    reference: toStr(r.reference) ?? undefined,
    description: toStr(r.description) ?? undefined,
    debit: toNum(r.debit) || undefined,
    credit: toNum(r.credit) || undefined,
    runningBalance: r.running_balance != null ? toNum(r.running_balance) : undefined,
  }));

  const { inserts } = buildInserts(reconciliationId, syntheticLines, invoices);
  await persistLinesAndUpdateCounts(reconciliationId, inserts);

  const result = await fetchFullReconciliation(companyId, reconciliationId);
  if (!result) throw new Error('Failed to retrieve rematch result');
  return result;
}

export async function markReconciled(
  companyId: string,
  reconciliationId: string,
  userId: string,
): Promise<void> {
  const [row] = (await sql`
    UPDATE supplier_statement_reconciliations
    SET status = 'reconciled', reconciled_at = NOW(),
        reconciled_by = ${userId}::uuid, updated_at = NOW()
    WHERE id = ${reconciliationId}::uuid AND company_id = ${companyId}
    RETURNING id
  `) as DbRow[];
  if (!row) throw new Error(`Reconciliation ${reconciliationId} not found`);
}
