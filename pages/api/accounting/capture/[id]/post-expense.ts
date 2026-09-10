/**
 * POST /api/accounting/capture/[id]/post-expense
 *
 * Second post path for the capture inbox: creates an expense claim (when an
 * employeeId is provided) or posts a direct GL journal entry (anonymous till
 * slip / petty-cash route) instead of a supplier invoice.
 *
 * Body: { employeeId?: string, costCentreId?: string, glAccountId?: string }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import {
  mapMerchantToExpenseAccount,
  type ReceiptAccountMapping,
} from '@/modules/accounting/services/bank/receiptToJournalService';
import {
  CaptureRowLockTimeoutError,
  CapturedDocumentAlreadyPostedError,
  claimCapturedDocumentForPosting,
  lockCaptureEventForPosting,
} from '@/modules/accounting/services/capture/captureRowLock';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  postReceiptAsPettyCashJournal,
  ReceiptDoesNotBalanceError,
} from '@/modules/accounting/services/capture/pettyCashJournalService';
import {
  INPUT_VAT_DENIED_ADVICE,
  resolveVatCodeForAccount,
  VAT_CODE_STANDARD,
} from '@/modules/accounting/services/gl/inputVatDenial';
import {
  createClaim,
  submitClaim,
  type ExpenseClaimLine,
} from '@/modules/accounting/services/expense/expenseClaimService';

type Row = Record<string, unknown>;

interface PostExpenseBody {
  employeeId?: string;
  costCentreId?: string;
  glAccountId?: string;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const userId = req.user?.id ?? '';
  const eventId = req.query.id as string;

  if (!eventId) return apiResponse.badRequest(res, 'eventId is required');

  // ------------------------------------------------------------------
  // 1. Lock and load the event + its document
  // ------------------------------------------------------------------
  // The DOCUMENT is the row every posting route has to agree on, so it is
  // locked first on every path — document-then-event, never the reverse, so
  // there is no cycle to deadlock on. The refusals below are check-then-act;
  // under the locks they read settled values. Nothing is written yet, so a lock
  // timeout is a safe 4xx.
  let event;
  try {
    event = await lockCaptureEventForPosting(companyId, eventId);
  } catch (err) {
    if (err instanceof CaptureRowLockTimeoutError) return apiResponse.badRequest(res, err.message);
    throw err;
  }

  if (!event) return apiResponse.notFound(res, 'Capture event', eventId);

  if (event.eventStatus === 'posted') {
    return apiResponse.badRequest(res, 'Event already posted');
  }

  // The document's own status, which this route never read. `receipt-to-journal`
  // refuses on it and stamps it; this route stamped it and refused on the EVENT
  // instead, so posting a receipt there and then opening the same document in
  // the capture inbox wrote a SECOND VAT-bearing journal against one receipt —
  // an ordinary two-step operator workflow, no concurrency in it anywhere.
  if (event.documentStatus === 'matched') {
    return apiResponse.badRequest(res, 'Document already posted to a journal');
  }

  if (!event.extractedData) {
    return apiResponse.badRequest(res, 'Document has no extracted data — extraction may still be in progress');
  }

  const documentId = event.documentId;
  const extracted = event.extractedData as ExtractedDocument;

  const { employeeId, costCentreId, glAccountId: bodyGlAccountId } = req.body as PostExpenseBody;

  // ------------------------------------------------------------------
  // 2. Resolve GL expense account
  // ------------------------------------------------------------------
  let resolvedGlAccountId: string;

  if (bodyGlAccountId) {
    // Caller specified explicit GL account — verify it belongs to this company
    const acctRows = await sql`
      SELECT id FROM gl_accounts
      WHERE id = ${bodyGlAccountId}::uuid AND company_id = ${companyId}
      LIMIT 1
    ` as Row[];
    if (acctRows.length === 0) {
      return apiResponse.badRequest(res, 'glAccountId not found for this company');
    }
    resolvedGlAccountId = bodyGlAccountId;
  } else if (extracted.vendorName) {
    // Try merchant-pattern lookup
    const allAccts = await sql`
      SELECT id, account_code AS code, account_name AS name
      FROM gl_accounts
      WHERE company_id = ${companyId}
        AND is_active = true
    ` as Row[];
    const mappings: ReceiptAccountMapping[] = allAccts.map(a => ({
      id: a.id as string,
      code: a.code as string,
      name: a.name as string,
    }));
    const suggestion = mapMerchantToExpenseAccount(extracted.vendorName, mappings);
    resolvedGlAccountId = suggestion?.id ?? await getSystemAccountId('default_expense', companyId);
  } else {
    resolvedGlAccountId = await getSystemAccountId('default_expense', companyId);
  }

  // Always resolve VAT Input account — required for correct journal
  let vatInputAccountId: string;
  try {
    vatInputAccountId = await getSystemAccountId('vat_input', companyId);
  } catch (err) {
    // Only a MISSING ROLE is a configuration answer — `getSystemAccountId` runs
    // a real query, and a bare `catch` reported a transient database fault as
    // "set it up in Default Accounts", unlogged and pointing at the wrong fix.
    if (!(err instanceof MissingSystemAccountError)) throw err;
    log.warn('Post-expense refused: VAT Input account not configured',
      { companyId, eventId, err: err.message }, 'capture-post-expense');
    return apiResponse.badRequest(res, 'VAT Input system account not configured — set it up in Default Accounts');
  }

  // ------------------------------------------------------------------
  // 3a. Employee path → create expense claim + auto-submit
  // ------------------------------------------------------------------
  if (employeeId) {
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
    const vatAmt = claimDenial.denied
      ? 0
      : extracted.vatAmount ?? Math.round((total / 1.15 * 0.15) * 100) / 100;

    const line: ExpenseClaimLine = {
      lineDate,
      description: extracted.vendorName ?? 'Expense receipt',
      merchant: extracted.vendorName ?? null,
      amount: total,
      vatAmount: vatAmt,
      vatCode: claimDenial.vatCode,
      glAccountId: resolvedGlAccountId,
      costCentreId: costCentreId ?? null,
      projectId: null,
      sourceDocumentId: documentId,
      kmTravelled: null,
      kmRate: null,
      mileageFrom: null,
      mileageTo: null,
    };

    // Claim the document before the first write: the status read above is a
    // check-then-act, and this status-predicated UPDATE is what settles it. Last
    // point at which a 4xx is safe — a refusal matched no row, so
    // `withAuth`'s commit-on-4xx commits nothing.
    if (!await claimCapturedDocumentForPosting(companyId, documentId, 'expense')) {
      return apiResponse.badRequest(res, 'Document already posted to a journal');
    }

    const claim = await createClaim({
      companyId,
      employeeId,
      claimDate: lineDate,
      title: extracted.vendorName ? `Expense: ${extracted.vendorName}` : 'Expense receipt',
      createdBy: userId,
      lines: [line],
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

  // ------------------------------------------------------------------
  // 3b. Anonymous path → direct GL journal (petty cash / company card)
  // ------------------------------------------------------------------
  // A mis-extracted receipt is a 400, not a 500. The service throws before its
  // first write, so answering 4xx here commits nothing — see the error's own
  // doc-comment for why that ordering is what makes this safe.
  let result;
  try {
    result = await postReceiptAsPettyCashJournal({
      companyId,
      userId,
      eventId,
      documentId,
      extracted,
      resolvedGlAccountId,
      vatInputAccountId,
      costCentreId,
    });
  } catch (err) {
    if (err instanceof ReceiptDoesNotBalanceError) {
      return apiResponse.badRequest(res, err.message);
    }
    // The service claims the document after its last SELECT, so this is a 4xx
    // that commits nothing either.
    if (err instanceof CapturedDocumentAlreadyPostedError) {
      return apiResponse.badRequest(res, err.message);
    }
    // The service resolves the Bank role as its first statement, before any
    // write. Left unmapped it 500'd here while the identical condition on the
    // VAT Input role above answered 400 — the same misconfiguration, two
    // different answers depending on which account was missing.
    if (err instanceof MissingSystemAccountError) {
      log.warn('Post-expense refused: system account not configured',
        { companyId, eventId, err: err.message }, 'capture-post-expense');
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }

  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
