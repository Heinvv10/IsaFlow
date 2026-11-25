/**
 * The other things a RECEIVER does with an intercompany message (P2): reject it (a reason is required and goes back to the
 * sender's outbox), dismiss it (set aside, it can be restored), restore a dismissed one, or - the worker's - mark one failed with a
 * generic sentence. All of them touch only the message row: nothing here writes a document, and nothing here touches the
 * sender's books (a rejection never changes the sender's invoice). The database enforces the same rules (guard 1002: a write
 * role in the receiving company, an active connection to reject or restore, accepted and rejected are final).
 * P4-C: an `allocation` message (the payer's cash on a linked bill) is rejected or dismissed through the same transitions
 * (`rejectAllocation`, `dismissAllocation`, `restoreAllocation`), found by its own loader: the invoice functions never reach one, and nothing
 * accepts one (D).
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { ConnectionRefusal } from './connectionTypes';
import { loadInboxRow } from './inboxRead';
import { loadAllocationRow } from './allocationInbox';
import { mayApprove } from '../core/approvePermission';
import { loanClearingEnabled } from './loanClearingGate';

// checkReason lives in inboxValidation (pure, no database import); re-exported so existing callers keep working.
export { checkReason } from './inboxValidation';

type Row = Record<string, unknown>;

/** The database's refusal of a guarded change, as a sentence: 42501 a role, 23514 the message's or connection's state. */
function refusalOf(err: unknown): ConnectionRefusal | null {
  const code = (err as { code?: string } | null)?.code;
  if (code === '42501') return new ConnectionRefusal(403, 'You need a write role in this company to handle intercompany messages.');
  if (code === '23514') return new ConnectionRefusal(409, 'This message cannot be changed now (it was already handled, or the connection is no longer active).');
  return null;
}

async function move(
  companyId: string, messageId: string, from: string[], run: () => Promise<Row[]>, what: string,
  load: (companyId: string, messageId: string) => Promise<Row | null> = loadInboxRow,
): Promise<void> {
  const row = await load(companyId, messageId);
  if (!row) throw new ConnectionRefusal(404, 'Message not found');
  if (!from.includes(String(row.status))) throw new ConnectionRefusal(409, `This message is ${String(row.status)}, so it cannot be ${what}.`);
  let changed: Row[];
  try {
    changed = await withSavepoint('intercompany_handle', run);
  } catch (err) {
    const refusal = refusalOf(err);
    if (refusal) throw refusal;
    throw err;
  }
  if (changed.length === 0) throw new ConnectionRefusal(409, 'This message was handled by someone else.');
  log.info(`Intercompany message ${what}`, { companyId, messageId }, 'intercompany');
}

export function rejectMessage(companyId: string, messageId: string, reason: string): Promise<void> {
  return move(companyId, messageId, ['pending', 'failed'], async () => (await sql`
    UPDATE intercompany_messages SET status = 'rejected', reason = ${reason}
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND status IN ('pending', 'failed') RETURNING id
  `) as Row[], 'rejected');
}

export function dismissMessage(companyId: string, messageId: string): Promise<void> {
  return move(companyId, messageId, ['pending', 'failed'], async () => (await sql`
    UPDATE intercompany_messages SET status = 'dismissed'
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND status IN ('pending', 'failed') RETURNING id
  `) as Row[], 'dismissed');
}

/** An allocation message (P4-C): rejected with a reason, as an invoice message is; only an allocation message moves. P4-D round 1 (breaker
 *  M3): rejecting a payment is final, so it needs Approve on Customers & AR, as clearing one does (asked before anything is read). */
export async function rejectAllocation(companyId: string, userId: string, messageId: string, reason: string): Promise<void> {
  if (!(await mayApprove(companyId, userId, 'customers'))) {
    throw new ConnectionRefusal(403, 'You need Approve on Customers & AR to reject a payment from your group. An owner or admin can grant it in User Access.');
  }
  return move(companyId, messageId, ['pending', 'failed'], async () => (await sql`
    UPDATE intercompany_messages SET status = 'rejected', reason = ${reason}
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'allocation' AND status IN ('pending', 'failed') RETURNING id
  `) as Row[], 'rejected', loadAllocationRow);
}

export function dismissAllocation(companyId: string, messageId: string): Promise<void> {
  return move(companyId, messageId, ['pending', 'failed'], async () => (await sql`
    UPDATE intercompany_messages SET status = 'dismissed'
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'allocation' AND status IN ('pending', 'failed') RETURNING id
  `) as Row[], 'dismissed', loadAllocationRow);
}

/** A dismissed allocation message back to pending (the guard needs the connection active, and marks it a person's to handle). */
export function restoreAllocation(companyId: string, messageId: string): Promise<void> {
  return move(companyId, messageId, ['dismissed'], async () => (await sql`
    UPDATE intercompany_messages SET status = 'pending'
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'allocation' AND status = 'dismissed' RETURNING id
  `) as Row[], 'restored', loadAllocationRow);
}

/** One payment message of this company, raw (id, status), or null: what reject / dismiss / restore of a payment message check first. */
async function loadPaymentRow(companyId: string, messageId: string): Promise<Row | null> {
  const rows = (await sql`
    SELECT id, status FROM intercompany_messages WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'payment'
  `) as Row[];
  return rows[0] ?? null;
}

/**
 * A payment message (F): rejected, dismissed or restored as an allocation message is. AUTHORIZATION lives HERE, not in the route: rejecting
 * is FINAL, so it needs the receiver's dark flag `intercompany_loan_clearing` (round 1 LOW-4: 403 before anything) and Approve on Customers &
 * AR (`mayApprove`, 403 before anything is read or written); the route adds withAuth, CSRF, the write role (withWriteAccess) and no Login-as.
 * Dismiss and restore are reversible and touch only the message's status, so they stay allowed with the flag off (a receiver can still tidy
 * the list); they need the write role (withWriteAccess on the route, and the database guard 1002 for every role).
 */
export async function rejectPayment(companyId: string, userId: string, messageId: string, reason: string): Promise<void> {
  if (!(await loanClearingEnabled(companyId))) {
    throw new ConnectionRefusal(403, 'Intercompany payment messages are not enabled for this company.');
  }
  if (!(await mayApprove(companyId, userId, 'customers'))) {
    throw new ConnectionRefusal(403, 'You need Approve on Customers & AR to reject a payment from your group. An owner or admin can grant it in User Access.');
  }
  return move(companyId, messageId, ['pending'], async () => (await sql`
    UPDATE intercompany_messages SET status = 'rejected', reason = ${reason}
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'payment' AND status = 'pending' RETURNING id
  `) as Row[], 'rejected', loadPaymentRow);
}

export function dismissPayment(companyId: string, messageId: string): Promise<void> {
  return move(companyId, messageId, ['pending'], async () => (await sql`
    UPDATE intercompany_messages SET status = 'dismissed'
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'payment' AND status = 'pending' RETURNING id
  `) as Row[], 'dismissed', loadPaymentRow);
}

export function restorePayment(companyId: string, messageId: string): Promise<void> {
  return move(companyId, messageId, ['dismissed'], async () => (await sql`
    UPDATE intercompany_messages SET status = 'pending'
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'payment' AND status = 'dismissed' RETURNING id
  `) as Row[], 'restored', loadPaymentRow);
}

export function restoreMessage(companyId: string, messageId: string): Promise<void> {
  return move(companyId, messageId, ['dismissed'], async () => (await sql`
    UPDATE intercompany_messages SET status = 'pending'
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND status = 'dismissed' RETURNING id
  `) as Row[], 'restored');
}

/**
 * The worker's: a message it could not accept is marked failed with a sentence, so it is not tried again and a person sees why.
 * Only a still-pending message moves; the sentence is generic (never exception text: a database message names ids).
 */
export async function markMessageFailed(companyId: string, messageId: string, sentence: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE intercompany_messages SET status = 'failed', error = ${sentence.slice(0, 500)}
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND status = 'pending' RETURNING id
  `) as Row[];
  return rows.length > 0;
}
