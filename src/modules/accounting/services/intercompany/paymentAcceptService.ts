/**
 * The RECEIVER accepts a `payment` message (intercompany F, plan (a).3, (c), (k), (l)): a person of this company (its own session, the
 * intercompany write role, the create right on customer receipts) chooses one of two outcomes, in the request's ONE transaction:
 *   existing  "this is my receipt RC-x": the message is accepted with that receipt as its target. NOTHING else is written: no document, no
 *             allocation, no journal; the receipt stays as it is (one receipt may absorb several payment messages up to its total, MED-2).
 *   draft     "draft a receipt for it": ONE customer receipt, status draft, eft, on a bank account of this company the person picks, dated as the
 *             person picks, allocated to the open invoices the person picks for EXACTLY the payload amount, created through
 *             `createCustomerPayment` (its invoice locks and open-less-pending-drafts cap apply), stamped `IC:<message>`, then the message
 *             accepted with it. Confirming it is the normal receipt Confirm by a person with Approve, behind the confirm gate (icDraftConfirmGate).
 * NO JOURNAL is posted here, in either company. There is no auto-accept of payment messages (Q4): nothing but this person's request accepts one.
 *
 * Every refusal comes from READS before the first write and is a plain 4xx (`PaymentRefusal`): the dark flag off for this company (403, first,
 * before anything is read), not the person's own session, no write role or no create right, not this company's message (404), not pending,
 * the state word not `open`, the receipt or the draft refused (paymentAcceptRules.ts, in its order), what the person saw has changed (409).
 * After the first write (the draft) any failure is a plain Error (5xx: withAuth rolls the request back). The guard (migration 1031) judges the
 * accepted transition again (H2: `open`, the receipt rules, consumption).
 * LOCK ORDER: paymentAcceptReads.ts (message, payer keys, receipt, invoices).
 */
import { sql, withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { checkPermission } from '@/lib/auth/permissionService';
import { createCustomerPayment } from '../ar/customerPaymentService';
import { isReceiptRefusal } from '../ar/receiptRefusal';
import { postingDateRefusal, todaySast } from './allocationClearDate';
import { userCanWrite } from './allocationClearReads';
import { loanClearingEnabled } from './loanClearingGate';
import { parsePaymentPayload, type PaymentPayload } from './paymentPayload';
import { openInvoices, receiptCandidates, scopeOf } from './paymentSuggestions';
import { draftRefusal } from './paymentRanking';
import { PaymentRefusal, cents, judgeDraft, judgeExisting, stateSentence, type AcceptPaymentInput } from './paymentAcceptRules';
import { bankAccountOk, draftInvoiceFacts, existingFacts, lockPaymentMessage, markAccepted, stampDraft, stateNow, type LockedPayment } from './paymentAcceptReads';
import type { AcceptPaymentOutcome } from './paymentInboxTypes';

type Row = Record<string, unknown>;
const sqlstate = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

export interface AcceptPaymentParams { companyId: string; messageId: string; userId: string; input: AcceptPaymentInput }

/** The person checks shared with the discard: the flag first, then the session, then the roles. */
export async function assertPaymentActor(companyId: string, userId: string, right: 'write' | 'approve'): Promise<void> {
  const store = als.getStore();
  if (!store?.client) throw new Error('an intercompany payment action needs a request transaction');
  if (store.userId !== userId || (store.companyId !== undefined && store.companyId !== companyId)) {
    throw new Error('an intercompany payment action: the actor is not the session user of this company');
  }
  const actor = await currentSessionActor();
  if (actor === 'impersonation') throw new PaymentRefusal('impersonating');
  if (actor !== 'self') throw new PaymentRefusal('not_own_session');
  if (!(await userCanWrite(companyId))) throw new PaymentRefusal('no_write_role');
  if (!(await checkPermission(companyId, userId, 'customers', right))) throw new PaymentRefusal(right === 'write' ? 'no_create_right' : 'no_approve');
}

/** Tighten-only 5 s bound on every row-lock wait (never loosening a tighter caller's); the caller's value is put back after. */
async function boundLockWait(): Promise<string> {
  const rows = (await sql`
    SELECT prev, pg_catalog.set_config('lock_timeout', CASE WHEN prev::interval = interval '0' OR prev::interval > interval '5s' THEN '5s' ELSE prev END, true)
      FROM (SELECT pg_catalog.current_setting('lock_timeout') AS prev) s
  `) as Row[];
  return String(rows[0]?.prev ?? '0');
}

export async function acceptPaymentMessage(p: AcceptPaymentParams): Promise<AcceptPaymentOutcome> {
  const { companyId, messageId, userId, input } = p;
  if (!(await loanClearingEnabled(companyId))) throw new PaymentRefusal('not_enabled');
  await assertPaymentActor(companyId, userId, 'write');
  const prev = await boundLockWait();
  let message: LockedPayment | null;
  try {
    message = await withSavepoint('ic_payment_lock', () => lockPaymentMessage(companyId, messageId));
  } catch (err) {
    if (sqlstate(err) === '55P03' || sqlstate(err) === '40P01') throw new PaymentRefusal('busy');
    throw err;
  }
  if (!message) throw new PaymentRefusal('not_found');
  if (message.status !== 'pending') throw new PaymentRefusal('not_pending');
  const parsed = parsePaymentPayload(message.payload);
  if (!parsed.ok) throw new PaymentRefusal('state', 'This payment message cannot be read, so it cannot be matched.');
  const state = await stateNow(message.id);
  if (state !== 'open') throw new PaymentRefusal('state', stateSentence(state) || undefined);
  const out = input.outcome === 'existing'
    ? await acceptExisting(companyId, message, parsed.payload, input)
    : await acceptDraft(companyId, userId, message, parsed.payload, input);
  await sql`SELECT pg_catalog.set_config('lock_timeout', ${prev}, true)`;
  log.info('Intercompany payment message accepted', { companyId, messageId, outcome: out.outcome, receiptId: out.receiptId }, 'intercompany');
  return out;
}

async function acceptExisting(companyId: string, m: LockedPayment, pl: PaymentPayload, input: Extract<AcceptPaymentInput, { outcome: 'existing' }>): Promise<AcceptPaymentOutcome> {
  const facts = await existingFacts(companyId, m, input.receiptId);
  const short = facts.unconsumedCents < cents(pl.amount);
  const refusal = judgeExisting({ expected: input.expected, amount: pl.amount, state: 'open', candidate: facts.ok || short, unconsumedCents: facts.unconsumedCents });
  if (refusal) throw new PaymentRefusal(refusal);
  // the one write; the guard judges it again (a disagreement is pre-write: nothing else was written, so it is the 422 it would have been)
  let accepted: boolean;
  try {
    accepted = await withSavepoint('ic_payment_accept', () => markAccepted(companyId, m.id, input.receiptId));
  } catch (err) {
    if (sqlstate(err) === '23514') throw new PaymentRefusal('receipt_not_candidate');
    throw err;
  }
  if (!accepted) throw new PaymentRefusal('not_pending');
  const [r] = (await sql`SELECT payment_number FROM customer_payments WHERE id = ${input.receiptId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return { accepted: true, messageId: m.id, outcome: 'existing', receiptId: input.receiptId, receiptNumber: String(r?.payment_number ?? '') };
}

async function acceptDraft(companyId: string, userId: string, m: LockedPayment, pl: PaymentPayload,
  input: Extract<AcceptPaymentInput, { outcome: 'draft' }>): Promise<AcceptPaymentOutcome> {
  const scope = await scopeOf(companyId, m.connectionId);
  const offered = scope.customerId && scope.cutover ? await openInvoices(companyId, scope.customerId, scope.cutover) : [];
  const candidates = scope.customerId ? await receiptCandidates({ companyId, messageId: m.id, connectionId: m.connectionId, payload: pl }, scope.customerId) : [];
  const invoices = await draftInvoiceFacts(companyId, input.allocations, scope.customerId, scope.cutover);
  const today = await todaySast();
  const dateRefusal = input.paymentDate >= pl.payment.date && input.paymentDate <= today ? await postingDateRefusal(companyId, input.paymentDate) : null;
  const refusal = judgeDraft({
    expected: input.expected, amount: pl.amount, state: 'open', offeredInvoiceIds: offered.map((i) => i.id), draftBlock: draftRefusal(candidates),
    bankAccountOk: await bankAccountOk(companyId, input.bankAccountId), paymentDate: input.paymentDate, payloadDate: pl.payment.date, today,
    invoices, dateRefusal,
  });
  if (refusal) throw new PaymentRefusal(refusal);
  let created: { id: string; paymentNumber: string };
  try {
    created = await createCustomerPayment(companyId, {
      clientId: scope.customerId!, paymentDate: input.paymentDate, totalAmount: pl.amount, paymentMethod: 'eft', bankAccountId: input.bankAccountId,
      description: `Intercompany payment ${pl.payment.number ?? pl.payment.reference ?? ''} (message ${m.id}): match the bank line to this receipt, do not allocate it again`,
      allocations: input.allocations,
    }, userId);
  } catch (err) {
    // createCustomerPayment refuses before its INSERT (a typed refusal): still nothing written, so still the 4xx it is
    if (isReceiptRefusal(err)) throw new PaymentRefusal((err as { retryable?: boolean }).retryable ? 'busy' : 'exceeds_open');
    throw err;
  }
  // after the first write: any failure is a plain Error (5xx, the request rolls back)
  if (!(await stampDraft(companyId, created.id, m.id))) throw new Error('the intercompany draft receipt could not be stamped');
  if (!(await markAccepted(companyId, m.id, created.id))) throw new Error('the payment message could not be accepted with its draft receipt');
  return { accepted: true, messageId: m.id, outcome: 'draft', receiptId: created.id, receiptNumber: created.paymentNumber };
}
