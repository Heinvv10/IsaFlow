/**
 * The RECEIVER clears an allocation message (intercompany P4-D, plan docs/plans/2026-11-23-intercompany-p4d-receiver-clearing.md, section (i)
 * binding): a person with a write role and Approve on Customers & AR presses Accept, and in the request's ONE transaction this re-checks
 * everything under its locks and posts exactly one contra settlement of the company's customer invoice against its intercompany loan account
 * (`settleDocumentByContra`: DR loan / CR Accounts Receivable, a confirmed `contra` customer receipt), stamps that receipt `IC:<message id>`
 * and marks the message `accepted` with the receipt as its target. Nothing else: no bank leg, no VAT, no payer-side write.
 *
 * AUTOMATION IS NOT APPROVAL. The actor is the session user (the route passes `req.user.id`; it must equal the bound transaction's user):
 * creator == approver == that person (slice A's rule until a decision record exists); `system:ic_allocation_clear` only labels the journal's
 * author. Only a person's OWN session clears (`currentSessionActor() === 'self'`): a Login-as session is refused, and so is a session with no
 * session id (a receiver worker, a bearer token: it fails closed), then a user without the intercompany write role or without Approve, BEFORE
 * anything is read.
 * There is no maker-checker between the payer and the receiver: a person with write roles in both companies may do both (rulings).
 *
 * LOCK ORDER (the only one): the message and its cap siblings FOR UPDATE, the payer's advisory locks (its payment, journal, bill: every
 * receiver's clearing of them waits), the connection, this company's side and the link FOR SHARE, the invoice FOR UPDATE, the loan account FOR
 * SHARE, then the composed services' own (the receipt, the period, the VAT key). `allocationClearReads.ts`.
 *
 * REFUSALS NEVER REJECT. Every refusal of a check (and a refusal code of the composed services, a lock wait or a deadlock) rolls the clearing's
 * savepoint back, THEN stores the message as `failed` with a fixed sentence (`allocationClearRefusals.ts`), answered 200 with
 * `accepted: false`: the message stays open for a person. Only a person's Reject writes `rejected`. A stale preview (the loan account,
 * invoice or amount the person approved is not what the books say now) is a 409 and a bad posting date a 400, both before any write; the
 * person checks are 403s. Anything else propagates (a 5xx: withAuth rolls the request back). No 4xx is answered after a write.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { approveRefusedMessage, mayApprove } from '../core/approvePermission';
import { ContraSettlementRefusal, isContraPreWriteRefusal, settleDocumentByContra } from '../core/contraSettlementPosting';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { lockReceiptInvoices } from '../ar/receiptInvoiceLock';
import { ConnectionRefusal } from './connectionTypes';
import { parseMirrorPayload } from './mirrorPayload';
import {
  askLive, invoiceFacts, lockAllocationMessages, lockConnection, lockLink, lockLoanAccount, lockOwnSide, lockPayerCaps, pairCutover,
  pendingDraftAmount, userCanWrite, type LockedMessage,
} from './allocationClearReads';
import { postingDateRefusal, todaySast } from './allocationClearDate';
import { CLEAR_REFUSAL_SENTENCES, MISMATCH_SENTENCE, cents, expectedMismatch, refusalOfCode } from './allocationClearRefusals';
import { ClearRefusal, type AcceptAllocationInput, type AcceptAllocationOutcome, type ClearRefusalCode } from './allocationClearTypes';

type Row = Record<string, unknown>;

/** Stamped on the clearing's journal as its author (never a person, never an approver). */
export const IC_ALLOCATION_POSTING_AGENT = 'system:ic_allocation_clear';

const OPEN = new Set(['pending', 'failed']);
const OPEN_INVOICE: ReadonlySet<string> = new Set(AR_OPEN_STATUSES);
/** The definer's cap answers the clearing knows; anything else it might answer is refused generically. */
const CAPS: ReadonlySet<string> = new Set(['cash_not_through_loan', 'already_cleared']);
const sqlstate = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

export interface AcceptAllocationParams {
  companyId: string;
  messageId: string;
  /** The session user (the route's `req.user.id`): creator and approver of the clearing. */
  userId: string;
  input: AcceptAllocationInput;
}

export async function acceptAllocation(p: AcceptAllocationParams): Promise<AcceptAllocationOutcome> {
  const { companyId, messageId, userId, input } = p;
  // Programming errors, not refusals: the clearing is atomic only inside the request's transaction, and the actor IS its user.
  const store = als.getStore();
  if (!store?.client) throw new Error('acceptAllocation needs a request transaction');
  if (store.userId !== userId || (store.companyId !== undefined && store.companyId !== companyId)) {
    throw new Error('acceptAllocation: the actor is not the session user of this company');
  }
  // The person first, before any row of the message is read (plan (i).6): their OWN session (fails closed on one without a session id).
  const actor = await currentSessionActor();
  if (actor === 'impersonation') throw new ImpersonationForbiddenError();
  if (actor !== 'self') throw new ConnectionRefusal(403, 'Clearing a payment needs your own signed-in session (not a token or an automated run).');
  if (!(await userCanWrite(companyId))) throw new ConnectionRefusal(403, 'You need a write role in this company to clear an intercompany payment.');
  if (!(await mayApprove(companyId, userId, 'customers'))) throw new ConnectionRefusal(403, approveRefusedMessage('customers', 'customer receipts'));

  const prev = await boundLockWait();
  const message = await lockMessage(companyId, messageId);
  if (!message) throw new ConnectionRefusal(404, 'Message not found');
  if (!OPEN.has(message.status)) throw new ConnectionRefusal(409, `This payment message is ${message.status}, so it cannot be cleared.`);

  let outcome: AcceptAllocationOutcome;
  try {
    outcome = await withSavepoint('ic_allocation_clear', () => clear(companyId, userId, message, input));
  } catch (err) {
    const refusal = classify(err);
    if (refusal === null) throw err;
    if (refusal === 'forbidden') throw new ConnectionRefusal(403, approveRefusedMessage('customers', 'customer receipts'));
    // the savepoint is rolled back: nothing of the clearing stands; the refusal is stored on the message, which stays open
    log.info('Intercompany allocation clearing refused', { companyId, messageId, reason: refusal, code: sqlstate(err) }, 'intercompany');
    outcome = await markFailed(companyId, messageId, refusal);
  }
  await sql`SELECT pg_catalog.set_config('lock_timeout', ${prev}, true)`;
  return outcome;
}

/** Tighten-only 5 s bound on every row-lock wait of the clearing (never loosening a tighter caller's); the caller's value is put back after. */
async function boundLockWait(): Promise<string> {
  const rows = (await sql`
    SELECT prev, pg_catalog.set_config('lock_timeout', CASE WHEN prev::interval = interval '0' OR prev::interval > interval '5s' THEN '5s' ELSE prev END, true)
      FROM (SELECT pg_catalog.current_setting('lock_timeout') AS prev) s
  `) as Row[];
  return String(rows[0]?.prev ?? '0');
}

/** Lock steps 1 and 1b in a savepoint of their own: a wait that runs out is a 409 with nothing written (the message cannot be marked: it is held). */
async function lockMessage(companyId: string, messageId: string): Promise<LockedMessage | null> {
  try {
    return await withSavepoint('ic_allocation_lock', async () => {
      const message = await lockAllocationMessages(companyId, messageId);
      if (message) await lockPayerCaps(message.id);
      return message;
    });
  } catch (err) {
    if (sqlstate(err) === '55P03' || sqlstate(err) === '40P01') {
      throw new ConnectionRefusal(409, 'This payment message is being handled right now. Try again in a moment.');
    }
    throw err;
  }
}

/** Everything under the savepoint: every check first (the guard's too), then the one posting, the stamp and the accepted transition. */
async function clear(companyId: string, userId: string, message: LockedMessage, input: AcceptAllocationInput): Promise<AcceptAllocationOutcome> {
  const parsed = parseMirrorPayload(message.payload, 'allocation', message.fromCompanyId);
  if (!parsed.ok) throw new ClearRefusal('malformed');
  const pl = parsed.payload;
  // the person's date: a mistake in the request, refused before anything (the message is not at fault)
  if (input.postingDate < pl.payment.date) throw new ConnectionRefusal(400, 'The posting date must be on or after the payment date.');
  if (input.postingDate > await todaySast()) throw new ConnectionRefusal(400, 'The posting date cannot be after today.');

  const conn = await lockConnection(companyId, message.connectionId);
  if (!conn) throw new ClearRefusal('not_live');
  const side = await lockOwnSide(companyId, message.connectionId);
  await lockLink(companyId, pl.linkId, message.connectionId);
  if (!side?.loanAccountId) throw new ClearRefusal('no_loan_account');
  const invoiceId = pl.issuerDocument.id.toLowerCase();
  const stale = expectedMismatch(input, { loanAccountId: side.loanAccountId, invoiceId, amount: pl.amount });
  if (stale) throw new ConnectionRefusal(409, MISMATCH_SENTENCE[stale]);

  // the payer's books, asked under the locks: still true, and what they let be cleared
  const live = await askLive(message.id);
  if (!live.live) throw new ClearRefusal('not_live');

  const invoice = (await lockReceiptInvoices(companyId, [invoiceId])).get(invoiceId);
  if (!invoice || invoice.deleted || invoice.status === 'cancelled') throw new ClearRefusal('invoice_gone');
  if (!OPEN_INVOICE.has(invoice.status)) throw new ClearRefusal('invoice_not_open');
  const facts = await invoiceFacts(companyId, invoiceId);
  if (!facts) throw new ClearRefusal('invoice_gone');
  // (F4) the person's date, against the invoice: a mistake in the request, before anything
  if (facts.date && input.postingDate < facts.date) throw new ConnectionRefusal(400, "The posting date must be on or after your invoice's date.");
  if (!side.customerId || facts.customerId?.toLowerCase() !== side.customerId.toLowerCase()) throw new ClearRefusal('wrong_customer');
  if (pl.currency !== 'ZAR' || facts.currency !== 'ZAR') throw new ClearRefusal('currency');
  if (conn.kind !== 'group') throw new ClearRefusal('not_group');
  const cutover = await pairCutover(companyId, conn);
  if (!cutover || !facts.date || facts.date < cutover) throw new ClearRefusal('pre_cutover_invoice');
  if (pl.payment.date < cutover) throw new ClearRefusal('pre_cutover_payment');

  const account = await lockLoanAccount(companyId, side.loanAccountId);
  if (!account || !account.isActive || account.isParent || !account.loanClass) {
    throw new ClearRefusal('loan_account_unusable');
  }
  // the open amount, with the draft receipts already claiming it (refused, never clamped)
  const pending = await pendingDraftAmount(companyId, invoiceId);
  if (cents(pl.amount) > invoice.totalCents - invoice.paidCents - cents(pending)) throw new ClearRefusal('exceeds_open');
  // the caps across every receiver of this payer (the definer's answer, under the payer's advisory locks), then the two loan accounts' types
  if (live.cap !== null) throw new ClearRefusal(CAPS.has(live.cap) ? live.cap as ClearRefusalCode : 'refused');
  if (!live.payerLoanType) throw new ClearRefusal('cash_not_through_loan');
  if (live.payerLoanType === account.accountType) throw new ClearRefusal('loan_class_mismatch');
  const dateRefusal = await postingDateRefusal(companyId, input.postingDate);
  if (dateRefusal) throw new ClearRefusal(dateRefusal);

  const posted = await settleDocumentByContra({
    companyId, subledger: 'ar', documentId: invoiceId, contraAccountId: side.loanAccountId, amount: pl.amount, date: input.postingDate,
    reason: `intercompany payment ${pl.payment.number ?? pl.payment.reference ?? ''} cleared against the loan account (message ${message.id})`,
    actor: { userId, approverUserId: userId, postingAgent: IC_ALLOCATION_POSTING_AGENT },
  });
  if (!posted.journalEntryId) throw new Error('the allocation clearing posted no journal');
  const stamped = (await sql`
    UPDATE customer_payments SET bank_reference = ${`IC:${message.id}`}
     WHERE id = ${posted.paymentId}::UUID AND company_id = ${companyId}::UUID AND payment_method = 'contra' AND bank_reference IS NULL
     RETURNING id
  `) as Row[];
  if (stamped.length !== 1) throw new Error('the allocation clearing receipt could not be stamped');
  const accepted = (await sql`
    UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = ${posted.paymentId}::UUID, error = NULL
     WHERE id = ${message.id}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'allocation' AND status IN ('pending', 'failed')
     RETURNING id
  `) as Row[];
  if (accepted.length !== 1) throw new Error('the allocation message could not be accepted');
  log.info('Intercompany allocation cleared', { companyId, messageId: message.id, paymentId: posted.paymentId, journalEntryId: posted.journalEntryId }, 'intercompany');
  return { accepted: true, messageId: message.id, paymentId: posted.paymentId, paymentNumber: posted.paymentNumber, journalEntryId: posted.journalEntryId };
}

/** What an error under the clearing's savepoint counts as: a refusal (stored), `forbidden` (403), or null (propagates). */
function classify(err: unknown): ClearRefusalCode | 'forbidden' | null {
  if (err instanceof ClearRefusal) return err.reason;
  if (err instanceof ConnectionRefusal) return null;
  if (isContraPreWriteRefusal(err)) return refusalOfCode(sqlstate(err), { contraRefusal: err instanceof ContraSettlementRefusal });
  if (err instanceof MissingSystemAccountError) return refusalOfCode(null, { missingSystemAccount: true });
  const e = err as { retryable?: unknown; held?: unknown } | null;
  return refusalOfCode(sqlstate(err), { retryable: e?.retryable === true || e?.held === true });
}

/** The refusal on the message, written after the savepoint was rolled back: `failed` with its fixed sentence (never `rejected`). */
async function markFailed(companyId: string, messageId: string, code: ClearRefusalCode): Promise<AcceptAllocationOutcome> {
  const sentence = CLEAR_REFUSAL_SENTENCES[code];
  const rows = (await sql`
    UPDATE intercompany_messages SET status = 'failed', error = ${sentence}
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'allocation' AND status IN ('pending', 'failed')
     RETURNING id
  `) as Row[];
  if (rows.length !== 1) throw new ConnectionRefusal(409, 'This message was handled by someone else.');
  return { accepted: false, messageId, status: 'failed', code, error: sentence };
}
