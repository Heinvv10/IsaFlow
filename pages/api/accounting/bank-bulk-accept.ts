/**
 * Bulk accept of high-confidence suggestions (audit WP6, Hein decision 2a.2). The API half: preview, confirm, undo.
 *
 * GET  ?bankAccountId=<uuid>[&minConfidence=0.9]
 *      → the lines a bulk accept would post (rows, total in / out, by account) and a `previewToken` pinning them.
 * POST { action: 'confirm', previewToken }   (+ optional Idempotency-Key header: a resend after a lost answer replays the first
 *      answer - same runId - instead of posting twice; withHttpIdempotency. Every refusal of a confirm is decided before its
 *      first write, which is what that wrapper needs.)
 *      → posts every pinned line that is still the line previewed and still passes the gate, each under its own
 *        savepoint: { runId, posted: [...], refused: [{ txId, reason }], totalPosted }. 200 even when every line was refused.
 * POST { action: 'undo', runId }
 *      → undoes exactly that batch (the auto-post run undo): { reversed, skipped, alreadyUndone, undone, ... }.
 *
 * The same access as the single accept (withWriteAccess). Rate limited per company; at most BULK_ACCEPT_MAX_LINES per confirm.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withHttpIdempotency } from '@/lib/idempotency/withHttpIdempotency';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { isUuidParam } from '@/lib/validation';
import { assertBankAccountInCompany, isBankAccountGuardRefusal } from '@/modules/accounting/services/bank/bankAccountGuard';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import { previewBulkAccept, isBulkAcceptRefusal } from '@/modules/accounting/services/bank/bankBulkAcceptPreview';
import { confirmBulkAccept, undoBulkAcceptBatch } from '@/modules/accounting/services/bank/bankBulkAcceptService';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';
import { ErrorCode } from '@/lib/apiResponse.types';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;
  if (req.method !== 'GET' && req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);

  try {
    if (req.method === 'GET') {
      const { bankAccountId, minConfidence, scanAfter } = req.query;
      if (!isUuidParam(bankAccountId)) return apiResponse.badRequest(res, 'bankAccountId is required');
      const wanted = minConfidence === undefined ? undefined : Number(minConfidence);
      if (wanted !== undefined && !Number.isFinite(wanted)) return apiResponse.badRequest(res, 'minConfidence must be a number');
      if (scanAfter !== undefined && !isUuidParam(scanAfter)) return apiResponse.badRequest(res, 'scanAfter must be an id from a previous preview');
      if (!(await checkReportRateLimit(companyId, 'bank-bulk-accept-preview'))) {
        return apiResponse.tooManyRequests(res, 'Too many previews. Please try again shortly.');
      }
      await assertBankAccountInCompany(companyId, bankAccountId);
      return apiResponse.success(res, await previewBulkAccept(companyId, userId, bankAccountId, wanted, scanAfter as string | undefined));
    }

    const body = (req.body ?? {}) as { action?: string; previewToken?: unknown; runId?: unknown };
    if (body.action === 'confirm') {
      // The quota is spent only by a request that gets as far as work: a bad token (400) and a busy account (409) do not.
      const result = await confirmBulkAccept(companyId, userId, body.previewToken,
        () => checkReportRateLimit(companyId, 'bank-bulk-accept', { max: 10 }));
      return apiResponse.success(res, result);
    }
    if (body.action === 'undo') {
      if (!isUuidParam(body.runId)) return apiResponse.badRequest(res, 'runId is required');
      if (!(await checkReportRateLimit(companyId, 'bank-bulk-accept-undo', { max: 10 }))) {
        return apiResponse.tooManyRequests(res, 'Too many undo requests. Please try again shortly.');
      }
      const runId = body.runId;
      const result = await withJournalDateRefusal(res, () => undoBulkAcceptBatch(companyId, runId, userId));
      if (result === JOURNAL_DATE_REFUSED) return;
      log.info('Bulk accept batch undo requested', { companyId, runId, ...result }, 'bank-bulk-accept');
      return apiResponse.success(res, result);
    }
    return apiResponse.badRequest(res, "POST requires { action: 'confirm', previewToken } or { action: 'undo', runId }");
  } catch (err) {
    // Typed refusals decided before any write keep their 4xx; everything else is a fault (500, rolled back).
    if (isBulkAcceptRefusal(err)) {
      return err.status === 404 ? apiResponse.error(res, ErrorCode.NOT_FOUND, err.message)
        : err.status === 409 ? apiResponse.conflict(res, err.message)
          : err.status === 429 ? apiResponse.tooManyRequests(res, err.message) : apiResponse.badRequest(res, err.message);
    }
    if (isBankAccountGuardRefusal(err)) return apiResponse.badRequest(res, err.message);
    if (respondIfBankControlRefused(res, err)) return;
    if (respondIfLockTimeout(res, err)) return;
    if (isRetryableContention(err)) return apiResponse.conflict(res, (err as Error).message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(withHttpIdempotency('bank-bulk-accept', handler) as Parameters<typeof withWriteAccess>[0]))));
