/**
 * The PAYER's allocation outbox (intercompany P4-B): when a payer's posted cash is applied to a bill that is one side of an ACTIVE link with
 * the partner's customer invoice, on a LOAN connection past its cut-over, one `allocation` message is written for the partner. MESSAGES ONLY:
 * no journal, no document, and nothing the partner's books do (the receiver's draft clearing and the loan contra-settlement are P4-C/D).
 *
 * The message is written by the DATABASE (`intercompany_send_for_allocation`, migration 1025): it reads the payer's payment, allocation row,
 * bill, link and connection, builds the payload itself and records the payment journal it stands on. This service names the allocation row and
 * nothing else, and the messages guard refuses a session's own INSERT of an allocation message.
 *
 * Called from the three places a payer's cash meets a bill, after their own write and on their own transaction (so the message commits or rolls
 * back with the payment): `applySupplierPaymentPlan`, `processSupplierPayment` and `processBatch` (a loan-mode clearing is `settle_by_contra`:
 * create, approve, process, and never reaches the apply function). Each allocation id runs in its OWN savepoint and the hook never throws: a
 * message that cannot be written is logged by SQLSTATE and the payment stands. Calling it twice, or for a payment that is not eligible, is
 * harmless: the definer answers `already_sent` / a named reason and writes nothing.
 *
 * DARK FLAG (`intercompany_loan_clearing`, loanClearingGate.ts): each entry point asks the PAYER company's flag ONCE, before any read,
 * savepoint or definer call; off (every company's default), it returns silently: no message, no savepoint, no log line. Both definers ask it
 * again in SQL (override, else is_global, no plan: a plan-only grant reads on here and off there, and fails closed).
 *
 * F (migration 1031, plan (k) L-4): the CASH connection's `payment` message. Per allocation id, inside its savepoint, the allocation definer
 * (D3) is asked FIRST; only when it answers `not_loan` is `intercompany_send_for_payment` (D1) asked, in a savepoint of its own. At most one
 * of them writes (IX1 and the payer journal key both take before their link / connection shares). A 23505 from either (the row already
 * has its message of the other kind) is info `other_kind_sent`, never the "not written" error; a D1 lock timeout (55P03) is log.error with
 * its SQLSTATE (M-4: the payer's unsent read lists it), never a thrown payment.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { loanClearingEnabled } from './loanClearingGate';

type Row = Record<string, unknown>;

/**
 * Reasons a person must find: nothing re-sends the message (a re-send is P5's reconciliation, which lists the unsent allocations).
 * `not_found` is always a bug here: the id was just inserted or read under this company, so the definer must find it.
 */
const AT_ERROR = new Set(['no_journal', 'not_found']);
const AT_WARN = new Set(['not_posted']);   // ('forbidden' is silent: a user without an intercompany write role pays bills all day, linked or not; P5 lists linked bills paid without a message)
/** D1's (plan (c), (l) MED-3): every other answer is silent (not the partner's supplier, not linked, a loan connection, already sent, ...). */
const PAYMENT_AT_ERROR = new Set(['not_found', 'no_journal', 'ambiguous', 'superseded']);
const PAYMENT_AT_WARN = new Set(['not_posted', 'no_cutover', 'before_cutover']);

const sqlstate = (err: unknown): string | null => (err as { code?: string })?.code ?? null;
const otherKind = (companyId: string, allocationId: string) =>
  log.info('Intercompany payment row already has its message', { companyId, allocationId, reason: 'other_kind_sent' }, 'intercompany');

async function send(companyId: string, allocationId: string): Promise<void> {
  // (a 23505 here rolls the id's savepoint back and is told apart in sendAll: the other kind already holds the row)
  const r = ((await sql`
    SELECT message_id, reason FROM public.intercompany_send_for_allocation(${allocationId}::UUID)
  `) as Row[])[0];
  if (r?.message_id) {
    log.info('Intercompany allocation message sent', { companyId, allocationId, messageId: String(r.message_id) }, 'intercompany');
    return;
  }
  const reason = String(r?.reason ?? 'failed');
  if (reason === 'not_loan') { await sendPayment(companyId, allocationId); return; }
  if (reason === 'payment_sent') { otherKind(companyId, allocationId); return; }
  if (AT_ERROR.has(reason)) {
    log.error('Intercompany allocation message not sent', { companyId, allocationId, reason }, 'intercompany');
  } else if (AT_WARN.has(reason)) {
    log.warn('Intercompany allocation message not sent', { companyId, allocationId, reason }, 'intercompany');
  }
}

/** D1 in a savepoint of its own (a failure, the lock timeout included, is logged by SQLSTATE and never thrown). */
async function sendPayment(companyId: string, allocationId: string): Promise<void> {
  let r: Row | undefined;
  try {
    r = (await withSavepoint('intercompany_payment', async () => (await sql`
      SELECT message_id, reason FROM public.intercompany_send_for_payment(${allocationId}::UUID)
    `) as Row[]))[0];
  } catch (err) {
    if (sqlstate(err) === '23505') { otherKind(companyId, allocationId); return; }
    log.error('Intercompany payment message not written', { companyId, allocationId, code: sqlstate(err) }, 'intercompany');
    return;
  }
  if (r?.message_id) {
    log.info('Intercompany payment message sent', { companyId, allocationId, messageId: String(r.message_id) }, 'intercompany');
    return;
  }
  const reason = String(r?.reason ?? 'failed');
  if (PAYMENT_AT_ERROR.has(reason)) log.error('Intercompany payment message not sent', { companyId, allocationId, reason }, 'intercompany');
  else if (PAYMENT_AT_WARN.has(reason)) log.warn('Intercompany payment message not sent', { companyId, allocationId, reason }, 'intercompany');
}

/** After a payer's cash was applied to its bills: the allocation message for each row, if it has a partner (never throws). */
export async function mirrorAllocations(companyId: string, allocationIds: readonly string[]): Promise<void> {
  if (allocationIds.length === 0 || !(await loanClearingEnabled(companyId))) return;
  await sendAll(companyId, allocationIds);
}

/** Each id in its own savepoint (the flag already asked by the caller). */
async function sendAll(companyId: string, allocationIds: readonly string[]): Promise<void> {
  for (const allocationId of allocationIds) {
    try {
      await withSavepoint('intercompany_allocation', () => send(companyId, allocationId));
    } catch (err) {
      // Never the payment's failure; the code, not the message text, goes to the log (a database message names ids). AT ERROR: nothing re-sends it.
      if (sqlstate(err) === '23505') otherKind(companyId, allocationId);
      else log.error('Intercompany allocation message not written', { companyId, allocationId, code: sqlstate(err) }, 'intercompany');
    }
  }
}

/** Reads allocation ids in a savepoint of their own (a failed read must not poison the caller's transaction), then mirrors them. */
async function mirrorRead(companyId: string, read: () => Promise<Row[]>): Promise<void> {
  if (!(await loanClearingEnabled(companyId))) return;
  let ids: string[];
  try {
    ids = (await withSavepoint('intercompany_allocation_ids', read)).map((r) => String(r.id));
  } catch (err) {
    log.error('Intercompany allocation messages not written: the allocation rows could not be read', { companyId, code: sqlstate(err) }, 'intercompany');
    return;
  }
  await sendAll(companyId, ids);
}

/** The same for every allocation row of these payments of the company (the process path, which wrote the payment's status, not the rows). */
export async function mirrorPaymentAllocations(companyId: string, paymentIds: readonly string[]): Promise<void> {
  if (paymentIds.length === 0) return;
  await mirrorRead(companyId, async () => (await sql`
    SELECT pa.id FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE sp.company_id = ${companyId}::UUID AND sp.id = ANY(${paymentIds as string[]}::UUID[])
    ORDER BY pa.id
  `) as Row[]);
}

/** The same for every member payment of a processed batch (the batch's journal is the cash the members stand on). */
export async function mirrorBatchAllocations(companyId: string, batchId: string): Promise<void> {
  await mirrorRead(companyId, async () => (await sql`
    SELECT pa.id FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE sp.company_id = ${companyId}::UUID AND sp.batch_id = ${batchId}::UUID
    ORDER BY pa.id
  `) as Row[]);
}
