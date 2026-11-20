/**
 * Reads of the intercompany inbox (P2): the messages addressed to THIS company. Runs on the request's transaction, so RLS
 * (1000, 1002) already limits every row to the session company's own messages; `to_company_id` is also named in each query.
 * The payload is the sender's data and is validated before any field is shown as a figure (`parseMirrorPayload`).
 */
import { sql } from '@/lib/neon';
import { toIsoTimestamp } from '@/lib/dateUtils';
import { parseMirrorPayload, payloadBlocker, type MirrorKind } from './mirrorPayload';
import type { InboxFilter, InboxItem, InboxPage, InboxStatus } from './inboxTypes';

type Row = Record<string, unknown>;

const OPEN: InboxStatus[] = ['pending', 'failed'];
const HANDLED: InboxStatus[] = ['accepted', 'rejected', 'dismissed', 'withdrawn'];

export const INBOX_PAGE_MAX = 100;
/** The attempts the auto-accept queue gives a message (migration 1013 `intercompany_auto_accept_queue`); a pending message that used them all needs a person. */
export const AUTO_ACCEPT_MAX_ATTEMPTS = 8;

const asText = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One message row as the list shows it. An unreadable payload still lists (so it can be rejected or dismissed) with its blocker. */
export function toInboxItem(r: Row): InboxItem {
  const kind = String(r.kind) as MirrorKind;
  const raw = (r.payload ?? {}) as Record<string, unknown>;
  const parsed = parseMirrorPayload(raw, kind, String(r.from_company_id));
  const p = parsed.ok ? parsed.payload : null;
  return {
    id: String(r.id), kind, status: String(r.status) as InboxStatus, connectionId: String(r.connection_id),
    senderName: p?.senderName ?? asText(raw.senderName) ?? 'Another company',
    number: p?.number ?? asText(raw.number, 50) ?? '(no number)',
    date: p?.date ?? null, dueDate: p?.dueDate ?? null, currency: p?.currency ?? asText(raw.currency, 3),
    subtotal: p?.subtotal ?? asNum(raw.subtotal), taxAmount: p?.taxAmount ?? asNum(raw.taxAmount), total: p?.total ?? asNum(raw.total),
    notes: p?.notes ?? null, creditsInvoiceNumber: p?.creditsInvoiceNumber ?? null,
    lineCount: p?.lines.length ?? 0, hasPdf: p?.pdf != null,
    blocker: parsed.ok ? payloadBlocker(parsed.payload) : parsed.error,
    reason: asText(r.reason, 2000), error: asText(r.error, 4000),
    groupMatch: r.group_match === 'matched' || r.group_match === 'variance' || r.group_match === 'unmatched' ? r.group_match : null,
    varianceReason: asText(r.group_variance, 500),
    sourceCancelled: r.source_cancelled_at != null,
    sourceChanged: false,
    autoExhausted: String(r.status) === 'pending' && r.manual_only !== true && Number(r.auto_attempts ?? 0) >= AUTO_ACCEPT_MAX_ATTEMPTS,
    handledAt: r.handled_at ? toIsoTimestamp(r.handled_at as Date | string) : null,
    handledVia: r.handled_via === 'auto' ? 'auto' : r.handled_via === 'user' ? 'user' : null,
    targetDocType: asText(r.target_doc_type, 50), targetDocId: r.target_doc_id ? String(r.target_doc_id) : null,
    createdAt: toIsoTimestamp(r.created_at as Date | string) ?? '',
  };
}

const COLUMNS = `m.id, m.kind, m.status, m.connection_id, m.from_company_id, m.payload, m.reason, m.error, m.handled_at,
                 m.handled_via, m.source_cancelled_at, m.auto_attempts, m.manual_only, m.target_doc_type, m.target_doc_id, m.source_doc_type, m.source_doc_id, m.created_at,
                 it.match_status AS group_match, it.variance_reason AS group_variance`;

/** Messages that need a person: the Bills tab badge. */
export async function openInboxCount(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n FROM intercompany_messages
     WHERE to_company_id = ${companyId}::UUID AND kind IN ('invoice', 'credit_note') AND status = ANY(${OPEN}::TEXT[])
  `) as Row[];
  return Number(rows[0]?.n ?? 0);
}

/** The Bills tab: how many messages need a person, and whether this company has any intercompany connection at all (else the tab is not shown). */
export async function inboxSummary(companyId: string): Promise<{ openCount: number; enabled: boolean }> {
  const openCount = await openInboxCount(companyId);
  const rows = (await sql`
    SELECT EXISTS (SELECT 1 FROM intercompany_connections WHERE company_low_id = ${companyId}::UUID OR company_high_id = ${companyId}::UUID) AS enabled
  `) as Row[];
  return { openCount, enabled: rows[0]?.enabled === true || openCount > 0 };
}

export async function listInbox(companyId: string, filter: InboxFilter, limit: number, offset: number): Promise<InboxPage> {
  const statuses = filter === 'handled' ? HANDLED : OPEN;
  const capped = Math.min(Math.max(Math.trunc(limit) || 25, 1), INBOX_PAGE_MAX);
  const skip = Math.max(Math.trunc(offset) || 0, 0);
  const rows = (await sql`
    SELECT ${sql.unsafe(COLUMNS)}, count(*) OVER ()::int AS total
      FROM intercompany_messages m LEFT JOIN intercompany_transactions it ON it.id = m.group_transaction_id
     WHERE m.to_company_id = ${companyId}::UUID AND m.kind IN ('invoice', 'credit_note') AND m.status = ANY(${statuses}::TEXT[])
     ORDER BY m.created_at DESC, m.id
     LIMIT ${capped} OFFSET ${skip}
  `) as Row[];
  return { items: rows.map(toInboxItem), total: Number(rows[0]?.total ?? 0), openCount: await openInboxCount(companyId) };
}

/** One message of this company, raw (the service reads the payload itself), or null. `lock` takes the row FOR UPDATE. */
export async function loadInboxRow(companyId: string, messageId: string, lock = false): Promise<Row | null> {
  const rows = (lock
    ? await sql`SELECT ${sql.unsafe(COLUMNS)} FROM intercompany_messages m LEFT JOIN intercompany_transactions it ON it.id = m.group_transaction_id
                WHERE m.id = ${messageId}::UUID AND m.to_company_id = ${companyId}::UUID AND m.kind IN ('invoice', 'credit_note') FOR UPDATE OF m`
    : await sql`SELECT ${sql.unsafe(COLUMNS)} FROM intercompany_messages m LEFT JOIN intercompany_transactions it ON it.id = m.group_transaction_id
                WHERE m.id = ${messageId}::UUID AND m.to_company_id = ${companyId}::UUID AND m.kind IN ('invoice', 'credit_note')`) as Row[];
  return rows[0] ?? null;
}

/** Whether the sender's document changed after it was sent (the database rebuilds the payload from the sender's books and compares it). Null: not this company's message. */
export async function messageSourceChanged(messageId: string): Promise<boolean | null> {
  const rows = (await sql`SELECT public.intercompany_message_source_changed(${messageId}::UUID) AS changed`) as Row[];
  return rows[0]?.changed == null ? null : rows[0].changed === true;
}
