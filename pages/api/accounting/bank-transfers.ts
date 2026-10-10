/**
 * Bank Transfers API
 * POST /api/accounting/bank-transfers - Transfer between two of the company's bank accounts
 * Posts one journal through the journal funnel (bank/bankTransferService): DR destination bank, CR source bank.
 * Under manual-journal enforcement, a rule matching the amount holds it instead: 202 { status: 'awaiting_approval',
 * journalId, requestId, requiredRole } — a draft journal and an approval request raised as the person.
 * Sage equivalent: Banking > Transfers
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { fmtDate } from '@/lib/fmtDate';
import { UUID } from '@/lib/schemas/common';
import { journalDayWindowError } from '@/modules/accounting/utils/journalDateWindow';
import { ledgerDaysOf } from '@/modules/accounting/services/gl/journalDateGuard';
import { ClosedFiscalPeriodError, InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { ApprovalNotRequiredError, ApprovalRuleNotFoundError } from '@/modules/accounting/services/gl/approvalAuthority';
import { ApprovalRequestStaleError } from '@/modules/accounting/services/gl/approvalDocumentErrors';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import {
  BankTransferRefusedError, PossibleDuplicateTransferError, postBankTransfer,
} from '@/modules/accounting/services/bank/bankTransferService';
import { ErrorCode } from '@/lib/apiResponse.types';
import { log } from '@/lib/logger';

/** gl_journal_lines.debit / credit are numeric(15,2). */
const MAX_AMOUNT = 9_999_999_999_999.99;

const TransferSchema = z.object({
  fromAccountId: UUID,
  toAccountId: UUID,
  amount: z.union([z.number(), z.string()]).transform(v => Number(v)).refine(
    n => Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT && Math.round(n * 100) / 100 === n, {
      message: 'Transfer amount must be a positive amount in rand and cents',
    }),
  reference: z.string().max(500).optional(),
  transferDate: z.string().max(30).optional(),
  confirmDuplicate: z.boolean().optional(),
}).refine(v => v.fromAccountId !== v.toAccountId, {
  message: 'Source and destination accounts must be different',
  path: ['toAccountId'],
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const parsed = TransferSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { fromAccountId, toAccountId, amount, reference, transferDate: rawDate, confirmDuplicate } = parsed.data;
  // The day Postgres stores (gl/journalDateGuard) must be a ledger date: 422 before anything runs. Empty means today.
  const day = rawDate ? (await ledgerDaysOf([rawDate])).get(rawDate) ?? null : fmtDate(new Date());
  if (day === null) return apiResponse.validationError(res, { transferDate: ['transferDate must be a real date (YYYY-MM-DD)'] });
  const windowError = journalDayWindowError(day);
  if (windowError) return apiResponse.validationError(res, { transferDate: [windowError] });

  try {
    // In a savepoint: a refusal raised after the draft exists (closed period, inactive account) rolls it back.
    const done = await withJournalDateRefusal(res, () => postBankTransfer(companyId, {
      fromAccountId, toAccountId, amount, transferDate: day, reference, confirmDuplicate,
    }, userId));
    if (done === JOURNAL_DATE_REFUSED) return;

    // Held under manual-journal enforcement (Hein, step-2 decision 6): a draft journal and a request raised as the
    // person — 202, nothing posted until another member approves and the journal is posted.
    if (done.status === 'awaiting_approval') {
      log.info('Bank transfer held for approval', {
        entryId: done.entry.id, requestId: done.requestId, amount, module: 'accounting',
      });
      const approver = done.requiredRole ? `${done.requiredRole} approval` : 'approval';
      return apiResponse.success(res, {
        status: done.status, journalId: done.entry.id, requestId: done.requestId, requiredRole: done.requiredRole,
        journalEntry: done.entry,
      }, `Transfer of R${amount.toFixed(2)} from ${done.fromName} to ${done.toName} saved as a draft journal awaiting `
        + `${approver}. Once approved, post it from the journal. When the bank statement shows it, match the statement `
        + 'line to this journal rather than allocating it as a transfer.', 202);
    }

    log.info('Bank transfer posted', {
      entryId: done.entry.id, entryNumber: done.entry.entryNumber, amount, module: 'accounting',
    });
    return apiResponse.success(res, {
      status: done.status,
      journalEntry: done.entry,
      message: `Transferred R${amount.toFixed(2)} from ${done.fromName} to ${done.toName}`,
    });
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return; // R-032 L5: 403, raised before any read
    // A held transfer's request raced a rule change (deactivated, or moved twice under the raise): the savepoint has
    // rolled the draft back, so nothing was saved and submitting again decides afresh.
    if (err instanceof ApprovalNotRequiredError || err instanceof ApprovalRuleNotFoundError
      || err instanceof ApprovalRequestStaleError) {
      return apiResponse.conflict(res, 'The approval rules changed while the transfer was being saved. Nothing was '
        + 'saved - submit it again.');
    }
    if (respondIfLockTimeout(res, err)) return;
    // 428: resend with confirmDuplicate once the person confirms it is a separate transfer.
    if (err instanceof PossibleDuplicateTransferError) {
      return apiResponse.error(res, ErrorCode.PRECONDITION_REQUIRED, err.message, { existingEntry: err.existingEntryNumber });
    }
    if (err instanceof BankTransferRefusedError || err instanceof ClosedFiscalPeriodError
      || err instanceof InactiveAccountError || err instanceof VatPeriodLockedError) {
      return apiResponse.badRequest(res, err.message);
    }
    // Anything else is the server's: the 500 rolls the request back.
    log.error('Failed to process bank transfer', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to process bank transfer');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
