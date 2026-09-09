/**
 * Recurring Journal Actions API
 * POST — pause, resume, cancel, generate
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  updateRecurringJournalStatus,
  generateJournalFromRecurring,
  RecurringJournalRequestError,
  RecurringJournalLockTimeoutError,
  RecurringJournalNotFoundError,
} from '@/modules/accounting/services/gl/recurringJournalService';

/** Detect by SQLSTATE + constraint name; pg localises and rewords messages. */
function isDuplicateEntryNumber(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown };
  return e?.code === '23505' && e?.constraint === 'uq_gl_je_company_entry_number';
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const { action, id } = req.body;
    const userId = req.user.id;
    if (!action || !id) return apiResponse.badRequest(res, 'action and id are required');

    switch (action) {
      case 'pause':
        await updateRecurringJournalStatus(companyId, id, 'paused');
        return apiResponse.success(res, { status: 'paused' });
      case 'resume':
        await updateRecurringJournalStatus(companyId, id, 'active');
        return apiResponse.success(res, { status: 'active' });
      case 'cancel':
        await updateRecurringJournalStatus(companyId, id, 'cancelled');
        return apiResponse.success(res, { status: 'cancelled' });
      case 'generate': {
        const journalId = await generateJournalFromRecurring(companyId, id, userId);
        return apiResponse.success(res, { journalId });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    // Only a caller fault becomes a 400. withAuth ROLLBACKs on >= 500 and
    // COMMITs everything else, so mapping every throw to 400 committed whatever
    // the action had already written before it failed — the caller was told the
    // action failed while its half-finished journal stayed in the books.
    // Anything not of this class is rethrown to withErrorHandler as a 500.
    // Contention is the one refusal that is transient, so it answers 409 rather
    // than 400: the same request will succeed once the peer finishes, and a
    // client cannot tell "retry this" from "stop" if both come back the same.
    // A wrong id — another tenant's included — answers 404 for the same reason:
    // it is not a malformed request, and no retry or correction of the body
    // will ever make it succeed. Both branches sit ABOVE the parent class they
    // extend, because instanceof matches the parent first otherwise.
    if (err instanceof RecurringJournalLockTimeoutError) {
      log.warn('Recurring journal action contended', { message: err.message }, 'accounting-api');
      return apiResponse.conflict(res, err.message);
    }
    if (err instanceof RecurringJournalNotFoundError) {
      log.warn('Recurring journal not found', { id: err.id }, 'accounting-api');
      return apiResponse.notFound(res, 'Recurring journal', err.id);
    }
    if (err instanceof RecurringJournalRequestError) {
      log.warn('Recurring journal action refused', { message: err.message }, 'accounting-api');
      return apiResponse.badRequest(res, err.message);
    }
    // A duplicate entry_number is the other transient refusal, and it belongs
    // with the 409 rather than the 500 for exactly the same reason: the same
    // request succeeds on retry. `generate_journal_entry_number` computes
    // MAX(seq)+1 in a BEFORE INSERT, so two journals numbered in the same
    // instant — any two posters in one company, not just two recurring
    // templates — take the same number and the loser gets 23505 on
    // `uq_gl_je_company_entry_number`. Answering that a 500 tells an operator
    // whose Generate was perfectly valid that WE broke, and gives no remedy.
    // Only that one constraint is mapped: any other unique violation on this
    // path is a real fault. It cannot be retried in place — the 23505 aborts
    // the transaction, so unlike `customerInvoiceCreateService`, which reserves
    // its number outside the insert, there is nothing left here to retry into.
    // withAuth COMMITs a 4xx, which is safe here because everything the action
    // wrote — the claim, the entry, its lines — is inside the `withTransaction`
    // that `generateJournalFromRecurring` opens, and inside a request that is a
    // SAVEPOINT: the 23505 takes a `ROLLBACK TO SAVEPOINT` on the way out, so
    // the COMMIT that follows has nothing of this action left to commit. The
    // test asserts that outcome — run_count, entry count, line count — rather
    // than the status code, because the status code is not what protects the
    // ledger here.
    if (isDuplicateEntryNumber(err)) {
      log.warn('Recurring journal entry number contended', { message: (err as Error).message }, 'accounting-api');
      return apiResponse.conflict(res, 'Another journal was numbered at the same moment. Nothing was posted — try again.');
    }
    log.error('Recurring journal action failed', { error: err }, 'accounting-api');
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
