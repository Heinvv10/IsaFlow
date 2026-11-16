/**
 * PRD-05 Phase 5 — Bank-first inverted workflow
 * GET  /api/accounting/provisional/outstanding
 *   List provisional JEs where needs_evidence=true.
 * POST /api/accounting/provisional/outstanding
 *   Body: { bankTxIds: string[] } — trigger provisional posting for each.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isPeriodRefusal } from '@/modules/accounting/services/bank/bankAllocationPeriod';
import { InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';

type Row = DbRow;

/** A refusal written for this audience (a period, an inactive account, a VAT lock): its text may reach the caller. */
const isCallerSafe = (err: unknown): boolean =>
  isPeriodRefusal(err) || err instanceof InactiveAccountError || err instanceof VatPeriodLockedError;
/** Anything else (a pg error naming a table, an internal fault) is generic in the body and logged in full. */
const callerSafeMessage = (err: unknown): string =>
  isCallerSafe(err) ? (err as Error).message : 'could not post (internal error)';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user?.id ?? '';

  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT
        je.id                       AS je_id,
        je.entry_date,
        je.description              AS je_description,
        je.extraction_confidence,
        je.created_at               AS je_created_at,
        bt.id                       AS bank_tx_id,
        bt.description              AS tx_description,
        bt.amount,
        bt.transaction_date,
        bt.prediction_confidence,
        s.name                      AS supplier_name,
        CURRENT_DATE - bt.transaction_date::DATE AS days_outstanding
      FROM gl_journal_entries je
      JOIN bank_transactions bt
        ON bt.provisional_je_id = je.id
       AND bt.company_id = ${companyId}::UUID
      LEFT JOIN suppliers s
        ON s.id = bt.predicted_supplier_id
       AND s.company_id = ${companyId}::UUID
      WHERE je.company_id = ${companyId}::UUID
        AND je.needs_evidence = true
      ORDER BY bt.transaction_date ASC
    `) as Row[];

    const data = rows.map((r) => ({
      jeId: String(r.je_id),
      entryDate: String(r.entry_date),
      jeDescription: r.je_description ? String(r.je_description) : null,
      extractionConfidence: r.extraction_confidence != null ? Number(r.extraction_confidence) : null,
      jeCreatedAt: String(r.je_created_at),
      bankTxId: String(r.bank_tx_id),
      txDescription: r.tx_description ? String(r.tx_description) : null,
      amount: Number(r.amount),
      transactionDate: String(r.transaction_date),
      predictionConfidence: r.prediction_confidence != null ? Number(r.prediction_confidence) : null,
      supplierName: r.supplier_name ? String(r.supplier_name) : null,
      daysOutstanding: r.days_outstanding != null ? Number(r.days_outstanding) : null,
    }));

    log.info('Listed outstanding provisional JEs', { companyId, count: data.length }, 'provisional-outstanding');
    return apiResponse.success(res, { outstanding: data, total: data.length });
  }

  if (req.method === 'POST') {
    const body = req.body as { bankTxIds?: unknown };
    if (!Array.isArray(body.bankTxIds) || body.bankTxIds.length === 0) {
      return apiResponse.badRequest(res, 'bankTxIds must be a non-empty array');
    }

    const bankTxIds = (body.bankTxIds as unknown[]).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );

    // One id at a time, each in its own savepoint (as the auto-post gate does per row): a throw rolls back that id's
    // writes, including a fiscal year its period pre-flight generated, and leaves the transaction usable for the
    // next. Concurrent ids shared one connection with no savepoint, so a late throw (an inactive account) COMMITTED
    // the draft journal and the generated periods behind a 200 {skipped:'error'}.
    const results: Array<Record<string, unknown>> = [];
    for (const id of bankTxIds) {
      try {
        const result = await withSavepoint('provisional_outstanding_row', () => postProvisional(companyId, id, userId));
        results.push({ bankTxId: id, ...result });
      } catch (err) {
        if (isCallerSafe(err)) {
          log.warn('postProvisional refused in batch endpoint', { companyId, bankTxId: id, error: (err as Error).message }, 'provisional-outstanding');
        } else {
          log.error('postProvisional failed in batch endpoint', { companyId, bankTxId: id, error: err }, 'provisional-outstanding');
        }
        results.push({ bankTxId: id, journalEntryId: null, skipped: 'error', error: callerSafeMessage(err) });
      }
    }

    return apiResponse.success(res, { results });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
