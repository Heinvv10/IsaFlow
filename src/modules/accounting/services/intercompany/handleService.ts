/**
 * The other things a RECEIVER does with an intercompany message (P2): reject it (a reason is required and goes back to the
 * sender's outbox), dismiss it (set aside, it can be restored), restore a dismissed one, or - the worker's - mark one failed with a
 * generic sentence. All of them touch only the message row: nothing here writes a document, and nothing here touches the
 * sender's books (a rejection never changes the sender's invoice). The database enforces the same rules (guard 1002: a write
 * role in the receiving company, an active connection to reject or restore, accepted and rejected are final).
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { ConnectionRefusal } from './connectionTypes';
import { loadInboxRow } from './inboxRead';

const REASON_MAX = 2000;

type Row = Record<string, unknown>;

/** A reason the sender will read: required, trimmed, bounded. Returns the reason or a sentence saying what is wrong. */
export function checkReason(reason: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  if (typeof reason !== 'string' || reason.trim() === '') return { ok: false, error: 'A reason is required to reject a message' };
  if (reason.trim().length > REASON_MAX) return { ok: false, error: `The reason is too long (at most ${REASON_MAX} characters)` };
  return { ok: true, reason: reason.trim() };
}

/** The database's refusal of a guarded change, as a sentence: 42501 a role, 23514 the message's or connection's state. */
function refusalOf(err: unknown): ConnectionRefusal | null {
  const code = (err as { code?: string } | null)?.code;
  if (code === '42501') return new ConnectionRefusal(403, 'You need a write role in this company to handle intercompany messages.');
  if (code === '23514') return new ConnectionRefusal(409, 'This message cannot be changed now (it was already handled, or the connection is no longer active).');
  return null;
}

async function move(
  companyId: string, messageId: string, from: string[], run: () => Promise<Row[]>, what: string,
): Promise<void> {
  const row = await loadInboxRow(companyId, messageId);
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
