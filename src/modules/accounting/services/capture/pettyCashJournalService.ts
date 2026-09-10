/**
 * The anonymous capture path: a till slip or company-card receipt with no
 * employee attached, posted straight to the GL as a petty-cash journal.
 *
 * Lifted out of `pages/api/accounting/capture/[id]/post-expense.ts` unchanged.
 * That route carries two unrelated outcomes — an expense claim for a named
 * employee, and this journal — and holding both put it over the 300-line cap.
 * Nothing here is new: the account resolution and the claim branch stay in the
 * route, and this function begins where the route's `employeeId` check ends.
 *
 * It is also the file that now DECIDES the VAT claim on this path, which is why
 * it calls the s17(2)(a) funnel directly rather than taking a boolean from the
 * route: `scripts/ci/check-vat-guard-coverage.ts` governs the file that tags a
 * line and posts it, and that is this one.
 */

import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import {
  buildExpenseJournalFromReceipt,
  shouldAutoPostReceipt,
} from '@/modules/accounting/services/bank/receiptToJournalService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  CapturedDocumentAlreadyPostedError,
  claimCapturedDocumentForPosting,
} from '@/modules/accounting/services/capture/captureRowLock';
import {
  INPUT_VAT_DENIED_ADVICE,
  resolveVatCodeForAccount,
  VAT_CODE_STANDARD,
} from '@/modules/accounting/services/gl/inputVatDenial';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';
import {
  postJournalEntry,
  ClosedFiscalPeriodError,
} from '@/modules/accounting/services/gl/journalEntryPostingService';

export interface PettyCashJournalInput {
  companyId: string;
  userId: string;
  eventId: string;
  documentId: string;
  extracted: ExtractedDocument;
  resolvedGlAccountId: string;
  vatInputAccountId: string;
  costCentreId?: string;
}

/**
 * The extraction does not balance — a caller-facing 400, not a 500.
 *
 * `withErrorHandler` masks every throw as a generic internal error, so without
 * a type the route cannot tell "the OCR read three figures that disagree" from
 * "the database is down" and the operator is shown "an unexpected error
 * occurred" on a document that is merely mis-extracted. `receipt-to-journal.ts`
 * already answers 400 on exactly this input; this is the same answer on the
 * path that was extracted out of the route.
 *
 * Safe to answer 4xx with, and only because of WHERE it is thrown:
 * `withAuth` COMMITs the request transaction on a 4xx, and nothing on this path
 * has written anything by then — the account reads above it are all SELECTs.
 */
export class ReceiptDoesNotBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptDoesNotBalanceError';
  }
}

export interface PettyCashJournalResult {
  journalEntry: { id: string; status: string };
  merchant: string | null;
  amount: number | null;
  inputVatDenied: boolean;
  warnings: string[];
}

export async function postReceiptAsPettyCashJournal(
  input: PettyCashJournalInput,
): Promise<PettyCashJournalResult> {
  const {
    companyId, userId, eventId, documentId,
    extracted, resolvedGlAccountId, vatInputAccountId, costCentreId,
  } = input;

  const total = extracted.totalAmount ?? 0;
  const entryDate = extracted.date ?? new Date().toISOString().slice(0, 10);

  const bankAccountId = await getSystemAccountId('bank', companyId);

  // `resolvedGlAccountId` is chosen by the user or a capture rule, NOT by the
  // merchant map — so the builder's merchant heuristic cannot see a receipt
  // coded straight to a flagged Entertainment or Staff Welfare account. Read
  // the account's own `vat_input_denied` marker and hand it in. Unattended:
  // this branch auto-posts under the same confidence gate.
  const accountDenial = await resolveVatCodeForAccount(
    companyId,
    resolvedGlAccountId,
    VAT_CODE_STANDARD,
    { eventId, documentId, source: 'capture_post_expense' },
  );

  const journalInput = buildExpenseJournalFromReceipt(
    extracted,
    { expenseAccountId: resolvedGlAccountId, vatInputAccountId, bankAccountId },
    { accountVatDenied: accountDenial.denied },
  );

  // Drop zero-value legs — buildExpenseJournalFromReceipt always emits a VAT
  // leg, and a zero-rated or exempt receipt extracts vatAmount = 0, which
  // validateJournalLine rejects. Dropping it cannot unbalance the entry.
  // Pre-existing here (this path was already dead on the source CHECK, so it
  // never surfaced); fixed alongside receipt-to-journal.ts, which migration 509
  // makes live.
  const postableLines = journalInput.lines
    .filter(l => l.debit !== 0 || l.credit !== 0)
    .map(l => ({
      glAccountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description,
      costCenterId: costCentreId,
      vatType: l.vatType,
    }));

  // Balance-check BEFORE the first write, the same pre-check
  // `receipt-to-journal.ts` runs and for the same reason: the legs come from
  // OCR — subtotal, vatAmount and totalAmount are extracted independently with
  // no enforced invariant — so a till slip mixing zero-rated and standard-rated
  // items yields subtotal + vat != total. `createJournalEntry` would reject it,
  // but as a plain `Error` that surfaces as a 500. Extracting this branch out
  // of the route left the two paths asymmetric; this restores the answer.
  const preCheck = validateJournalEntry(postableLines);
  if (!preCheck.valid) {
    throw new ReceiptDoesNotBalanceError(
      `Receipt does not balance — check the extracted amounts: ${preCheck.errors.join('; ')}`,
    );
  }

  // Claim the document before the first write, and AFTER the pre-check — every
  // step above this line is a SELECT or a pure function, so both the refusal
  // here and `ReceiptDoesNotBalanceError` above it are 4xx answers that commit
  // nothing. The route read `captured_documents.status` under the row lock; this
  // status-predicated UPDATE is the write that settles who posts, and it is what
  // stops the same receipt being posted through `receipt-to-journal` as well.
  const refusal = await claimCapturedDocumentForPosting(companyId, documentId, 'expense');
  if (refusal) {
    throw new CapturedDocumentAlreadyPostedError(refusal);
  }

  const jeEntry = await createJournalEntry(
    companyId,
    {
      entryDate,
      description: journalInput.description,
      source: 'auto_expense_receipt',
      sourceDocumentId: documentId,
      lines: postableLines,
    },
    userId,
  );

  // Auto-post when the receipt passes the gate (under R5 000 + high confidence)
  const confidence = typeof extracted.confidence === 'number' ? extracted.confidence : 0;
  const autoPost = shouldAutoPostReceipt(
    total, confidence, { maxAmount: 5000, minConfidence: 0.80 }, extracted.warnings,
  );

  let jeStatus = jeEntry.status;
  if (autoPost) {
    try {
      // Signature is (companyId, id, userId). This read
      // (jeEntry.id, userId, companyId) — every argument in the wrong slot, so
      // the lookup was `WHERE id = <userId> AND company_id = <jeId>`, which
      // matched nothing and threw "Journal entry not found". The catch below
      // swallowed it, so auto-post on this path has never actually posted
      // anything: the entry silently stayed a draft.
      await postJournalEntry(companyId, jeEntry.id, userId);
      jeStatus = 'posted';
    } catch (postErr) {
      // ONLY a closed fiscal period may be swallowed. That is a legitimate
      // business outcome — the journal stays a draft for someone to post once
      // the period reopens, which is the same end state as autoPost === false.
      //
      // Anything else is rethrown. Now that the arguments are in the right order
      // this call actually reaches the database, so a failure here can be a
      // Postgres error that ABORTS the request transaction; continuing past it
      // would run the stamps below against a dead transaction and report 200
      // for writes that can never commit.
      if (!(postErr instanceof ClosedFiscalPeriodError)) throw postErr;
      log.warn('Auto-post of expense receipt JE skipped — fiscal period closed, left as draft', {
        eventId, jeId: jeEntry.id,
      }, 'capture-post-expense');
    }
  }

  // Stamp the event on the REQUEST connection, not withTransaction.
  // withTransaction (neon.ts) takes a separate pool client with its own
  // BEGIN/COMMIT, so this update used to commit independently of the request
  // transaction — an event stamped 'posted' could survive a request that rolled
  // back, pointing at a journal entry that no longer exists and blocking any
  // retry (the handler refuses an event already 'posted'). On the request
  // client it commits or rolls back with the journal, and so does the document
  // claim taken above.
  await sql`
    UPDATE capture_events
    SET status = 'posted',
        posted_by = ${userId},
        posted_at = NOW(),
        document_category = 'expense',
        resolved_gl_account_id = ${resolvedGlAccountId}::uuid,
        resolved_cost_centre_id = ${costCentreId ?? null}::uuid,
        updated_at = NOW()
    WHERE id = ${eventId}::uuid AND company_id = ${companyId}
  `;

  log.info('Capture event posted as direct GL expense', {
    eventId, documentId, jeId: jeEntry.id, autoPost, jeStatus,
  }, 'capture-post-expense');

  return {
    journalEntry: { id: jeEntry.id, status: jeStatus },
    merchant: extracted.vendorName,
    amount: extracted.totalAmount,
    inputVatDenied: journalInput.inputVatDenied,
    warnings: journalInput.inputVatDenied ? [INPUT_VAT_DENIED_ADVICE] : [],
  };
}
