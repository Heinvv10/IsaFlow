/**
 * Supplier Statement Reconciliation — DB access layer
 *
 * All sql queries for supplier statement reconciliation.
 * Called by supplierStatementReconService.ts.
 */

import { sql } from '@/lib/neon';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import {
  toDateStr,
  toNum,
  toStr,
  type InvoiceRecord,
  type LineInsert,
  type MismatchReason,
} from './supplierStatementMatchHelper';
import type {
  ReconciliationLine,
  MissingInvoice,
  SupplierStatementReconciliation,
} from './supplierStatementReconService';

type DbRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Invoice loader
// ---------------------------------------------------------------------------

export async function loadSupplierInvoices(
  companyId: string,
  supplierId: string,
  periodStart: string | null,
  periodEnd: string | null,
): Promise<InvoiceRecord[]> {
  const rows = (await sql`
    SELECT si.id, si.invoice_number, si.invoice_date, si.total_amount
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}
      AND si.supplier_id = ${supplierId}::uuid
      -- Asked at the statement period end, so a bill deleted after that period
      -- still matches the supplier's statement lines for it.
      -- See shared/softDeleteLedgerPresence.
      AND ${documentInLedgerAsAtFragment('si', periodEnd ?? asAtTodayStr(), companyId)}
      -- MATCH candidates for the supplier's statement lines. Deliberately NOT
      -- the ageing's rule (shared/documentPopulation), which also drops drafts:
      -- a bill we still hold as a draft is worth matching to the line the
      -- supplier sent for it, and the variance — which does come from the
      -- ageing — still shows it is not yet owed. Only a cancelled bill is out.
      --
      -- This rule DOES reach figures: every line it fails to match counts in
      -- missing_in_isaflow_count, and the page will not mark a statement
      -- reconciled while that count is non-zero. The bare NOT IN was NULL for
      -- a NULL-status bill, so a statement that tied to the cent on the
      -- variance still read "missing in IsaFlow" and could not be reconciled.
      -- COALESCE admits NULL, the same reading documentPopulation gives it
      -- (R-059 round 8).
      AND COALESCE(si.status, '') <> 'cancelled'
      AND (${periodStart}::date IS NULL OR si.invoice_date >= ${periodStart}::date)
      AND (${periodEnd}::date IS NULL OR si.invoice_date <= ${periodEnd}::date)
    ORDER BY si.invoice_date
  `) as DbRow[];
  return rows.map((r) => ({
    id: r.id as string,
    invoiceNumber: String(r.invoice_number ?? ''),
    invoiceDate: toDateStr(r.invoice_date) ?? '',
    totalAmount: toNum(r.total_amount),
  }));
}

// ---------------------------------------------------------------------------
// Persist lines
// ---------------------------------------------------------------------------

export async function persistLinesAndUpdateCounts(
  reconId: string,
  inserts: LineInsert[],
): Promise<void> {
  await sql`DELETE FROM supplier_statement_lines WHERE reconciliation_id = ${reconId}::uuid`;
  for (const ln of inserts) {
    await sql`
      INSERT INTO supplier_statement_lines
        (reconciliation_id, line_date, reference, description, debit, credit,
         running_balance, matched_supplier_invoice_id, match_confidence, mismatch_reason)
      VALUES (
        ${reconId}::uuid, ${ln.lineDate}::date, ${ln.reference}, ${ln.description},
        ${ln.debit}, ${ln.credit}, ${ln.runningBalance},
        ${ln.matchedInvoiceId}::uuid, ${ln.matchConfidence}, ${ln.mismatchReason}
      )
    `;
  }
  await sql`
    UPDATE supplier_statement_reconciliations
    SET missing_in_isaflow_count   = ${inserts.filter((l) => l.mismatchReason === 'missing_in_isaflow').length},
        missing_in_statement_count = ${inserts.filter((l) => l.mismatchReason === 'missing_in_statement').length},
        amount_diff_count          = ${inserts.filter((l) => l.mismatchReason === 'amount_diff').length},
        updated_at                 = NOW()
    WHERE id = ${reconId}::uuid
  `;
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function mapLineRow(r: DbRow, invNum: string | null): ReconciliationLine {
  return {
    id: r.id as string,
    reconciliationId: r.reconciliation_id as string,
    lineDate: toDateStr(r.line_date),
    reference: toStr(r.reference),
    description: toStr(r.description),
    debit: toNum(r.debit),
    credit: toNum(r.credit),
    runningBalance: r.running_balance != null ? toNum(r.running_balance) : null,
    matchedSupplierInvoiceId: toStr(r.matched_supplier_invoice_id),
    matchedInvoiceNumber: invNum,
    matchConfidence: r.match_confidence != null ? toNum(r.match_confidence) : null,
    mismatchReason: (r.mismatch_reason as MismatchReason) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Full reconciliation fetch
// ---------------------------------------------------------------------------

export async function fetchFullReconciliation(
  companyId: string,
  reconId: string,
): Promise<SupplierStatementReconciliation | null> {
  const [header] = (await sql`
    SELECT ssr.*, s.name AS supplier_name
    FROM supplier_statement_reconciliations ssr
    JOIN suppliers s ON s.id = ssr.supplier_id
    WHERE ssr.id = ${reconId}::uuid AND ssr.company_id = ${companyId}
  `) as DbRow[];
  if (!header) return null;

  const lineRows = (await sql`
    SELECT ssl.*, si.invoice_number AS matched_invoice_number
    FROM supplier_statement_lines ssl
    LEFT JOIN supplier_invoices si ON si.id = ssl.matched_supplier_invoice_id
    WHERE ssl.reconciliation_id = ${reconId}::uuid
    ORDER BY ssl.line_date ASC NULLS FIRST, ssl.created_at ASC
  `) as DbRow[];

  const allLines = lineRows.map((r) => mapLineRow(r, toStr(r.matched_invoice_number)));
  const lines = allLines.filter((l) => l.mismatchReason !== 'missing_in_statement');
  const missingInvoices: MissingInvoice[] = allLines
    .filter((l) => l.mismatchReason === 'missing_in_statement')
    .map((l) => ({
      invoiceId: l.matchedSupplierInvoiceId ?? '',
      invoiceNumber: l.matchedInvoiceNumber ?? '',
      invoiceDate: l.lineDate ?? '',
      totalAmount: l.debit,
    }));

  return {
    id: header.id as string,
    companyId: header.company_id as string,
    supplierId: header.supplier_id as string,
    supplierName: String(header.supplier_name ?? ''),
    sourceDocumentId: header.source_document_id as string,
    statementDate: toDateStr(header.statement_date) ?? '',
    periodStart: toDateStr(header.period_start),
    periodEnd: toDateStr(header.period_end),
    supplierBalance: toNum(header.supplier_balance),
    isaflowBalance: toNum(header.isaflow_balance),
    variance: toNum(header.variance),
    status: (header.status as SupplierStatementReconciliation['status']) ?? 'unreconciled',
    missingInIsaflowCount: toNum(header.missing_in_isaflow_count),
    missingInStatementCount: toNum(header.missing_in_statement_count),
    amountDiffCount: toNum(header.amount_diff_count),
    lines,
    missingInvoices,
    createdAt: String(header.created_at ?? ''),
    reconciledAt: header.reconciled_at ? String(header.reconciled_at) : null,
  };
}
