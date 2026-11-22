/**
 * The employee path of POST /api/accounting/capture/[id]/post-expense: a captured receipt becomes an expense claim,
 * auto-submitted into the approval queue (split out of the route to keep it under the file-size cap, #1656 round 3).
 * It answers through `res`, as the route's other branches do; the caller has already locked the event and document, resolved
 * the expense account, and cleared the duplicate check.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { respondCapturedDocumentRefusal } from './capturePostingClaim';
import { claimCapturedDocumentForPosting } from './captureRowLock';
import type { checkReceiptDuplicate } from './receiptDuplicateGuard';
import {
  INPUT_VAT_DENIED_ADVICE,
  resolveVatCodeForAccount,
  VAT_CODE_NONE,
  VAT_CODE_STANDARD,
} from '../gl/inputVatDenial';
import { VAT_NOT_READ_SUFFIX } from '../bank/receiptToJournalService';
import { createClaim, submitClaim, type ExpenseClaimLine } from '../expense/expenseClaimService';

type Clear = Extract<Awaited<ReturnType<typeof checkReceiptDuplicate>>, { kind: 'clear' }>;

export interface PostExpenseClaimInput {
  companyId: string; userId: string; eventId: string; documentId: string; extracted: ExtractedDocument;
  employeeId: string; costCentreId: string | undefined; resolvedGlAccountId: string; duplicate: Clear;
}

export async function postExpenseAsClaim(res: NextApiResponse, p: PostExpenseClaimInput) {
  const { companyId, userId, eventId, documentId, extracted, employeeId, costCentreId, resolvedGlAccountId, duplicate } = p;
    const total = extracted.totalAmount ?? 0;
    const lineDate = extracted.date ?? new Date().toISOString().slice(0, 10);

    // s17(2)(a) applies to a claim exactly as it applies to the journal. It did
    // not: this branch put the machine-derived VAT on the claim line, and
    // `expenseClaimService.postClaim` debits VAT Input with the SUM of the line
    // `vatAmount`s — so the same entertainment receipt that the anonymous
    // branch denies produced the identical R150 input-tax claim through a
    // different table, and no advice was surfaced to the approver either.
    //
    // The account is what carries the marker, so resolve it against
    // `resolvedGlAccountId` before the amounts are built. On a denial the line
    // keeps the GROSS on `amount` and drops `vatAmount` to zero, which is the
    // same shape the journal branch posts: the whole cost lands on the expense
    // account and no VAT leg is created.
    const claimDenial = await resolveVatCodeForAccount(
      companyId,
      resolvedGlAccountId,
      VAT_CODE_STANDARD,
      { eventId, documentId, employeeId, source: 'capture_post_expense_claim' },
    );
    // No VAT read is no VAT claimed (K-072 r31): this used to derive 15/115 of
    // the total onto the claim line, shown to the approver as if the receipt
    // printed it. The line says so instead, and the approver can enter it.
    const vatRead = extracted.vatAmount !== null && extracted.vatAmount !== undefined;
    const vatAmt = claimDenial.denied || !vatRead ? 0 : extracted.vatAmount!;

    const line: ExpenseClaimLine = {
      lineDate,
      description: (extracted.vendorName ?? 'Expense receipt') + (vatRead ? '' : VAT_NOT_READ_SUFFIX),
      merchant: extracted.vendorName ?? null,
      amount: total,
      vatAmount: vatAmt,
      vatCode: vatRead ? claimDenial.vatCode : VAT_CODE_NONE,
      glAccountId: resolvedGlAccountId,
      costCentreId: costCentreId ?? null,
      projectId: null,
      sourceDocumentId: documentId,
      kmTravelled: null,
      kmRate: null,
      mileageFrom: null,
      mileageTo: null,
    };

    // Claim the document before the first write: the read above is a
    // check-then-act, and this `posted_at IS NULL` UPDATE is what settles it. Last
    // point at which a 4xx is safe — a refusal matched no row, so
    // `withAuth`'s commit-on-4xx commits nothing.
    const claimRefusal = await claimCapturedDocumentForPosting(companyId, documentId, 'expense', { spend: 'expense', ...duplicate.fingerprint });
    if (claimRefusal) {
      return respondCapturedDocumentRefusal(res, claimRefusal);
    }

    // The pre-check above holds its FOR SHARE lock to commit, so this cannot
    // refuse; if it ever does, it is left a 5xx so the claim write rolls back.
    const claim = await createClaim({
      companyId,
      employeeId,
      claimDate: lineDate,
      title: extracted.vendorName ? `Expense: ${extracted.vendorName}` : 'Expense receipt',
      createdBy: userId,
      lines: [line],
      sourceDocumentsClaimed: true,
    });

    // Auto-submit so it enters the approval queue immediately
    const submitted = await submitClaim(claim.id, companyId);

    // Request connection, not withTransaction — the claim above was created on
    // the request transaction, but withTransaction takes a SEPARATE pool client
    // with its own COMMIT, so this stamp used to persist even when the request
    // rolled back, marking the event 'posted' (and therefore un-retryable)
    // against a claim that no longer existed.
    await sql`
      UPDATE capture_events
      SET status = 'posted',
          posted_by = ${userId},
          posted_at = NOW(),
          document_category = 'expense',
          resolved_employee_id = ${employeeId}::uuid,
          resolved_gl_account_id = ${resolvedGlAccountId}::uuid,
          resolved_cost_centre_id = ${costCentreId ?? null}::uuid,
          updated_at = NOW()
      WHERE id = ${eventId}::uuid AND company_id = ${companyId}
    `;

    log.info('Capture event posted as expense claim', {
      eventId, documentId, claimId: claim.id, employeeId,
    }, 'capture-post-expense');

    return apiResponse.success(res, {
      expenseClaim: { id: submitted?.id ?? claim.id, claimNumber: submitted?.claimNumber ?? claim.claimNumber },
      merchant: extracted.vendorName,
      amount: extracted.totalAmount,
      inputVatDenied: claimDenial.denied,
      warnings: claimDenial.denied ? [INPUT_VAT_DENIED_ADVICE] : [],
    });
}
