/**
 * POST /api/accounting/capture/[id]/post-expense
 *
 * Second post path for the capture inbox: creates an expense claim (when an
 * employeeId is provided) or posts a direct GL journal entry (anonymous till
 * slip / petty-cash route) instead of a supplier invoice.
 *
 * Body: { employeeId?: string, costCentreId?: string, glAccountId?: string, confirmDuplicate?: boolean }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { resolveCaptureExpenseAccount } from '@/modules/accounting/services/capture/captureExpenseAccount';
import { respondCapturedDocumentRefusal, respondReceiptDuplicate } from '@/modules/accounting/services/capture/capturePostingClaim';
import {
  CAPTURED_DOCUMENT_REFUSAL_MESSAGE,
  CapturedDocumentAlreadyPostedError,
  lockCaptureEventForPosting,
  refusalForPosting,
} from '@/modules/accounting/services/capture/captureRowLock';
import { isCaptureEventPostable } from '@/modules/accounting/services/capture/captureEventLock';
import { checkReceiptDuplicate, type ReceiptDuplicateCheck } from '@/modules/accounting/services/capture/receiptDuplicateGuard';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  postReceiptAsPettyCashJournal,
  ReceiptDoesNotBalanceError,
} from '@/modules/accounting/services/capture/pettyCashJournalService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { documentLineAccountRefusal } from '@/modules/accounting/services/gl/documentLineAccountGuard';
import { PreWriteDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { postExpenseAsClaim } from '@/modules/accounting/services/capture/postExpenseClaim';
import { refuseWithoutApprove } from '@/modules/accounting/services/core/approvePermissionResponse';

interface PostExpenseBody {
  employeeId?: string;
  costCentreId?: string;
  glAccountId?: string;
  confirmDuplicate?: boolean;
}

type Postable = {
  event: NonNullable<Awaited<ReturnType<typeof lockCaptureEventForPosting>>>; documentId: string; extracted: ExtractedDocument;
  resolvedGlAccountId: string; vatInputAccountId: string; duplicate: Extract<ReceiptDuplicateCheck, { kind: 'clear' }>;
};

/** Steps 1-2, for both branches: the locks, the refusals and the accounts; `answered` is a refusal's response (nothing written). */
async function loadPostable(
  req: CompanyAuthedRequest, res: NextApiResponse, companyId: string, userId: string, eventId: string,
): Promise<{ ok: Postable } | { answered: unknown }> {
  // ------------------------------------------------------------------
  // 1. Lock and load the event + its document
  // ------------------------------------------------------------------
  // The DOCUMENT is the row every posting route has to agree on, so it is
  // locked first on every path — document-then-event, never the reverse, so
  // there is no cycle to deadlock on. The event lock is what makes the status
  // refusal below meaningful (R-058): two concurrent requests both read a
  // postable status and both post. Under the locks the refusals read settled
  // values; nothing is written yet, so a held row is a 503 + Retry-After.
  let event;
  try {
    event = await lockCaptureEventForPosting(companyId, eventId);
  } catch (err) {
    if (respondIfLockTimeout(res, err)) return { answered: undefined };
    throw err;
  }

  if (!event) return { answered: apiResponse.notFound(res, 'Capture event', eventId) };

  // Postable is an ALLOW-list (`captureEventLock.ts`), not `status === 'posted'`.
  // Naming one value left every OTHER terminal state postable: a user could
  // discard a captured document and then post it anyway, with no race at all.
  if (!isCaptureEventPostable(event.eventStatus)) {
    return { answered: apiResponse.badRequest(
      res,
      event.eventStatus === 'posted'
        ? 'Event already posted'
        : `Event cannot be posted from status '${event.eventStatus}'`,
    ) };
  }

  // The document's own posting claim, which this route never read — it refused
  // on the EVENT instead, so posting a receipt on another route and then
  // opening the same document in the capture inbox wrote a SECOND VAT-bearing
  // journal against one receipt: an ordinary two-step operator workflow, no
  // concurrency in it anywhere.
  const readRefusal = refusalForPosting({
    status: event.documentStatus,
    posted_at: event.documentPostedAt,
  });
  if (readRefusal) {
    return { answered: apiResponse.badRequest(res, CAPTURED_DOCUMENT_REFUSAL_MESSAGE[readRefusal]) };
  }

  if (!event.extractedData) {
    return { answered: apiResponse.badRequest(res, 'Document has no extracted data — extraction may still be in progress') };
  }

  const documentId = event.documentId;
  const extracted = event.extractedData as ExtractedDocument;

  const { glAccountId: bodyGlAccountId, confirmDuplicate } = (req.body ?? {}) as PostExpenseBody;

  // ------------------------------------------------------------------
  // 2. Resolve GL expense account
  // ------------------------------------------------------------------
  const resolvedGlAccountId = await resolveCaptureExpenseAccount(companyId, bodyGlAccountId, extracted.vendorName);
  if (resolvedGlAccountId === null) {
    return { answered: apiResponse.badRequest(res, 'glAccountId not found for this company') };
  }
  // Before the first write, so the 400 commits nothing; FOR SHARE also holds a merge off until commit.
  const accountRefusal = await documentLineAccountRefusal(companyId, [resolvedGlAccountId]);
  if (accountRefusal) return { answered: apiResponse.badRequest(res, accountRefusal) };

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
    return { answered: apiResponse.badRequest(res, 'VAT Input system account not configured — set it up in Default Accounts') };
  }

  // R-088: the same slip already posted from ANOTHER upload. Before any write, so the 409 commits nothing.
  const duplicate = await checkReceiptDuplicate(companyId, documentId, extracted, { confirmDuplicate: confirmDuplicate === true, userId });
  if (duplicate.kind !== 'clear') return { answered: respondReceiptDuplicate(res, duplicate) };
  return { ok: { event, documentId, extracted, resolvedGlAccountId, vatInputAccountId, duplicate } };
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const userId = req.user?.id ?? '';
  const eventId = req.query.id as string;

  if (!eventId) return apiResponse.badRequest(res, 'eventId is required');
  const { employeeId, costCentreId } = (req.body ?? {}) as PostExpenseBody;

  // ------------------------------------------------------------------
  // 3a. Employee path → create expense claim + auto-submit (it only queues: approving the claim takes its own Approve)
  // ------------------------------------------------------------------
  if (employeeId) {
    const loaded = await loadPostable(req, res, companyId, userId, eventId);
    if (!('ok' in loaded)) return loaded.answered;
    const { documentId, extracted, resolvedGlAccountId, duplicate } = loaded.ok;
    return postExpenseAsClaim(res, { companyId, userId, eventId, documentId, extracted, employeeId, costCentreId, resolvedGlAccountId, duplicate });
  }

  // ------------------------------------------------------------------
  // 3b. Anonymous path → direct GL journal (petty cash / company card)
  // ------------------------------------------------------------------
  // #1656 (Hein: gate everything): this branch POSTS a journal, so it takes Suppliers & AP Approve FIRST, before any lock, read or
  // duplicate check (#1670 breaker L2: a person without it learns nothing, not even DUPLICATE_RECEIPT).
  if (await refuseWithoutApprove(res, companyId, userId, 'suppliers', 'expense receipts')) return;
  const loaded = await loadPostable(req, res, companyId, userId, eventId);
  if (!('ok' in loaded)) return loaded.answered;
  const { event, documentId, extracted, resolvedGlAccountId, vatInputAccountId, duplicate } = loaded.ok;
  // A mis-extracted receipt is a 400, not a 500. The service throws before its
  // first write, so answering 4xx here commits nothing — see the error's own
  // doc-comment for why that ordering is what makes this safe.
  let result;
  try {
    result = await withJournalDateRefusal(res, () => postReceiptAsPettyCashJournal({
      companyId, userId, eventId, documentId, extracted,
      confirmedVendorName: event.documentVendorName,
      resolvedGlAccountId, vatInputAccountId, costCentreId,
      fingerprint: duplicate.fingerprint,
    }));
  } catch (err) {
    if (err instanceof ReceiptDoesNotBalanceError) {
      return apiResponse.badRequest(res, err.message);
    }
    // A cost centre that cannot be used, or dimensions a new journal may not carry (an inactive FNO): refused before the first write.
    if (err instanceof PreWriteDimensionRefusal) return apiResponse.badRequest(res, err.message);
    // The service claims the document after its last SELECT, so this is a 4xx
    // that commits nothing either.
    if (err instanceof CapturedDocumentAlreadyPostedError) {
      return respondCapturedDocumentRefusal(res, err.refusal, err.message);
    }
    // A receipt dated in a locked (filed) VAT period. The service refuses it
    // before claiming the document — its first write — so this 4xx commits
    // nothing either.
    if (err instanceof VatPeriodLockedError) {
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

  if (result !== JOURNAL_DATE_REFUSED) return apiResponse.success(res, result); // else answered 400 (apiJournalDate)
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
