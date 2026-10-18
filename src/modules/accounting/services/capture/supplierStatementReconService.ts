/**
 * Supplier Statement Reconciliation Service
 *
 * Upload → an 'extracting' reconciliation answered at once → a background job reads the statement
 * and matches its lines (supplierStatementExtractionJob) → the user reviews, rematches, marks
 * reconciled. A reconciliation that is 'extracting' or 'failed' has no lines to match or reconcile;
 * it can be retried or (failed only) deleted (supplierStatementLifecycle).
 *
 * DB queries:   supplierStatementReconDb.ts
 * Match logic:  supplierStatementMatchHelper.ts
 */

import { sql } from '@/lib/neon';
import {
  buildInserts,
  toDateStr,
  toNum,
  toStr,
  type MismatchReason,
} from './supplierStatementMatchHelper';
import { measureOurSide } from './supplierStatementMeasure';
import {
  extractionView,
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
  /** The figures below are null while the statement is not read yet ('extracting' or 'failed'). */
  statementDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  supplierBalance: number | null;
  isaflowBalance: number | null;
  variance: number | null;
  status: 'extracting' | 'unreconciled' | 'reconciled' | 'disputed' | 'archived' | 'failed';
  /** Why the read failed (status 'failed'). */
  extractionError: string | null;
  /** A failed read can be tried again, except a statement with too many pages. */
  retryable: boolean;
  /** Pages read so far and in all, while 'extracting' a PDF. */
  pagesDone: number | null;
  pagesTotal: number | null;
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
    periodStart: toDateStr(r.period_start),
    periodEnd: toDateStr(r.period_end),
    ...extractionView(r),
    missingInIsaflowCount: toNum(r.missing_in_isaflow_count),
    missingInStatementCount: toNum(r.missing_in_statement_count),
    amountDiffCount: toNum(r.amount_diff_count),
    lines: [],
    missingInvoices: [],
    createdAt: String(r.created_at ?? ''),
    reconciledAt: r.reconciled_at ? String(r.reconciled_at) : null,
  }));
}

/** Rematch of a reconciled statement. Thrown before any write, so the route may answer 409. */
export class ReconciliationClosedError extends Error {
  readonly code = 'RECONCILIATION_CLOSED';
  constructor(readonly reconciliationId: string) {
    super('This statement is already marked reconciled; Rematch would overwrite the variance it was reconciled at.');
    this.name = 'ReconciliationClosedError';
  }
}

/** Rematch or reconcile of a reconciliation that is still being read, or failed to be. Thrown before any write, so the route may answer 409. */
export class ReconciliationNotReadyError extends Error {
  readonly code = 'RECONCILIATION_NOT_READY';
  constructor(readonly reconciliationId: string, status: string) {
    super(status === 'extracting'
      ? 'This statement is still being read.'
      : 'This statement could not be read; retry it or delete it.');
    this.name = 'ReconciliationNotReadyError';
  }
}

export async function rematchLines(
  companyId: string,
  reconciliationId: string,
): Promise<SupplierStatementReconciliation> {
  // FOR UPDATE: the status check and the writes below are check-then-act.
  const [header] = (await sql`
    SELECT * FROM supplier_statement_reconciliations
    WHERE id = ${reconciliationId}::uuid AND company_id = ${companyId}
    FOR UPDATE
  `) as DbRow[];
  if (!header) throw new Error(`Reconciliation ${reconciliationId} not found`);
  // Closed: Rematch re-measures the variance, which would overwrite the one it
  // was reconciled at (stored nowhere else). Refused rather than re-matched
  // without the variance write, which would split counts from variance (R-059 r11).
  if (String(header.status) === 'reconciled') throw new ReconciliationClosedError(reconciliationId);
  // Nothing to match yet (or ever): a rematch would write zero lines over a read in progress.
  // The state a reader is shown: an interrupted read is 'failed' here too, so the refusal says what the page does.
  const readState = extractionView(header).status;
  if (readState === 'extracting' || readState === 'failed') throw new ReconciliationNotReadyError(reconciliationId, readState);

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

  // Re-measure our side too. Rematch re-reads the bills, so the counts move —
  // approving a draft turns its "missing in IsaFlow" line into a match — and a
  // variance left as it was struck at creation then belongs to a different set
  // of bills than those counts. That let a statement reconcile at a stale
  // variance of 0 while we owed twice what the supplier claimed, and kept a
  // phantom variance on one that now ties (R-059 round 10).
  const statementDate = toDateStr(header.statement_date);
  if (!statementDate) throw new Error(`Reconciliation ${reconciliationId} has no statement date`);
  const { isaflowBalance, variance } = await measureOurSide(
    companyId, header.supplier_id as string, statementDate, toNum(header.supplier_balance),
  );
  await sql`
    UPDATE supplier_statement_reconciliations
    SET isaflow_balance = ${isaflowBalance}, variance = ${variance}, updated_at = NOW()
    WHERE id = ${reconciliationId}::uuid AND company_id = ${companyId}
  `;

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
    WHERE id = ${reconciliationId}::uuid AND company_id = ${companyId} AND status NOT IN ('extracting', 'failed')
    RETURNING id
  `) as DbRow[];
  if (row) return;
  const [current] = (await sql`
    SELECT status FROM supplier_statement_reconciliations
    WHERE id = ${reconciliationId}::uuid AND company_id = ${companyId}
  `) as DbRow[];
  if (current) throw new ReconciliationNotReadyError(reconciliationId, String(current.status));
  throw new Error(`Reconciliation ${reconciliationId} not found`);
}
