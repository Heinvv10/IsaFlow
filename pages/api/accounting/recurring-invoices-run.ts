/**
 * Recurring Invoices Run API
 * POST — run one recurring invoice by ID, or all currently due
 * Body: { recurring_invoice_id?: string }
 * Returns: { generated: number; invoice_ids: string[]; held_for_approval: string[]; errors: string[] }
 *
 * R-035 PR4: an invoice an enforced approval rule governs is generated as a
 * draft with its approval request raised as the runner, and its schedule still
 * advances; it is counted in `generated`, listed in `invoice_ids`, and named
 * again in `held_for_approval` — it is not posted until it is approved.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { itemFailureMessage, respondIfLockTimeout, respondRowHeld } from '@/lib/apiDocumentLock';
import { isHeldRowError } from '@/lib/lockTimeout';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { assertTxUsable } from '@/lib/als';
import { runRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceService';
import type { DbRow } from '@/lib/neon';

interface RunResult {
  generated: number;
  invoice_ids: string[];
  /** The generated invoices left as drafts awaiting approval (R-035 PR4). */
  held_for_approval: string[];
  errors: string[];
  /** True when more due invoices remain beyond this run's batch cap —
   *  run again to continue. */
  remaining?: boolean;
}

/** P3.4: cap the run-all batch — an unbounded due-list meant an unbounded
 *  synchronous loop in one request (timeout risk). Remainder runs next call. */
const RUN_BATCH_CAP = 200;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const userId = req.user.id;
  const { recurring_invoice_id } = req.body as { recurring_invoice_id?: string };

  const result: RunResult = { generated: 0, invoice_ids: [], held_for_approval: [], errors: [] };

  if (recurring_invoice_id) {
    // Run a single recurring invoice
    try {
      const { invoiceId, heldForApproval } = await runRecurringInvoice(companyId, recurring_invoice_id, userId);
      result.generated = 1;
      result.invoice_ids = [invoiceId];
      if (heldForApproval) result.held_for_approval = [invoiceId];
      log.info('Single recurring invoice run', { recurring_invoice_id, invoiceId, heldForApproval }, 'recurring-run');
    } catch (err) {
      const msg = itemFailureMessage(err, 'Failed to generate invoice');
      result.errors.push(`${recurring_invoice_id}: ${msg}`);
      log.error('Recurring invoice run failed', { recurring_invoice_id, error: err }, 'recurring-run');
      assertTxUsable();
      if (respondIfLockTimeout(res, err)) return;
    }
    return apiResponse.success(res, result);
  }

  // Run all due — next_run_date <= today, status = 'active'
  const dueRowsRaw = (await sql`
    SELECT id
    FROM recurring_invoices
    WHERE company_id = ${companyId}
      AND status = 'active'
      AND next_run_date <= CURRENT_DATE
    ORDER BY next_run_date ASC
    LIMIT ${RUN_BATCH_CAP + 1}
  `) as DbRow[];

  // Chosen by due date, PROCESSED in id order. Each template stays locked
  // (FOR UPDATE, recurringInvoiceLock) until this request ends, and a customer
  // merge locks the same customer's templates ORDER BY id (K-061). Walking them
  // by due date instead was the inverse order for any two whose dates and ids
  // disagree: a 40P01 cycle. pg returns lower-case uuid text, whose string
  // order is Postgres's uuid order.
  const dueRows = dueRowsRaw.slice(0, RUN_BATCH_CAP)
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  if (dueRowsRaw.length > RUN_BATCH_CAP) {
    result.remaining = true;
    log.warn('Recurring run batch cap hit — more due invoices remain', {
      companyId, cap: RUN_BATCH_CAP,
    }, 'recurring-run');
  }

  if (dueRows.length === 0) {
    log.info('No due recurring invoices to run', { companyId }, 'recurring-run');
    return apiResponse.success(res, result);
  }

  let held = 0;
  for (const row of dueRows) {
    const id = String(row.id);
    try {
      const { invoiceId, heldForApproval } = await runRecurringInvoice(companyId, id, userId);
      result.generated += 1;
      result.invoice_ids.push(invoiceId);
      if (heldForApproval) result.held_for_approval.push(invoiceId);
    } catch (err) {
      const msg = itemFailureMessage(err, 'Failed to generate invoice');
      result.errors.push(`${id}: ${msg}`);
      if (isHeldRowError(err)) held += 1;
      log.error('Bulk recurring run — single item failed', { id, error: err }, 'recurring-run');
      // A per-template failure is normally a skip. But if the failure ALSO
      // poisoned the shared request transaction (a savepoint rollback that
      // itself failed), everything already in `invoice_ids` is doomed: the
      // success response below would COMMIT, Postgres would turn that COMMIT
      // into a ROLLBACK, and the caller would hold ids for invoices that do not
      // exist. Rethrow instead, so withErrorHandler answers 500 and withAuth
      // rolls back explicitly.
      assertTxUsable();
    }
  }

  // D11: when EVERY template attempted was a held row nothing was committed, so answer 503 + Retry-After instead of a
  // 200 a client cannot tell from success. Mixed results keep the 200 with per-item outcomes.
  if (held === dueRows.length) {
    return respondRowHeld(res, 'Every recurring invoice due is being run by another request — retry in a moment.', 'ROW_LOCK_TIMEOUT');
  }

  log.info('Bulk recurring invoice run complete', {
    total: dueRows.length,
    generated: result.generated,
    heldForApproval: result.held_for_approval.length,
    errors: result.errors.length,
  }, 'recurring-run');

  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
