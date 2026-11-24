/**
 * The RECEIVER's Payments inbox (intercompany F, cash mode): the `payment` messages a payer in the group sent THIS company (its bank cash applied
 * to a bill linked to one of this company's customer invoices). READ ONLY: nothing here writes (accept is paymentAcceptService's, discard
 * paymentDiscardService's, reject / dismiss / restore handleService's guarded transitions).
 *
 * Runs on the request's transaction (RLS limits every row to the session company, which each query names too). Each item carries the
 * payload's facts (display text only), this company's OWN issuer invoice looked up by the payload's id, an accepted message's receipt, and the
 * database's state word (`intercompany_payment_message_state`, D2), asked once per row in a savepoint of its own under one tighten-only 2 s
 * lock bound; a call that runs out of time ends the asking (the rest `check_failed`). Never a throw, never a poisoned transaction. The list and
 * the detail say whether the session company has the dark flag; off, the detail computes no suggestions.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { toIsoTimestamp } from '@/lib/dateUtils';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { ConnectionRefusal } from './connectionTypes';
import { INBOX_PAGE_MAX } from './inboxRead';
import { loanClearingEnabled } from './loanClearingGate';
import { parsePaymentPayload, type PaymentPayload } from './paymentPayload';
import { suggestionsFor } from './paymentSuggestions';
import type { InboxFilter, InboxStatus } from './inboxTypes';
import { PAYMENT_STATES, type PaymentDetail, type PaymentIssuerInvoice, type PaymentItem, type PaymentPage, type PaymentState } from './paymentInboxTypes';

type Row = Record<string, unknown>;
const OPEN: InboxStatus[] = ['pending', 'failed'];
const HANDLED: InboxStatus[] = ['accepted', 'rejected', 'dismissed', 'withdrawn'];
const OPEN_INVOICE: ReadonlySet<string> = new Set(AR_OPEN_STATUSES);
const STOP_CODES = new Set(['55P03', '57014']);
const sqlstate = (err: unknown): string | null => (err as { code?: string } | null)?.code ?? null;
const asText = (v: unknown, max = 2000): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);

/** D2 for one message in a savepoint of its own; `stop` when it ran out of time. Never throws. */
async function stateOf(companyId: string, messageId: string): Promise<{ state: PaymentState; live: boolean; stop: boolean }> {
  try {
    const rows = (await withSavepoint('intercompany_payment_state', async () => (await sql`
      SELECT live, state FROM public.intercompany_payment_message_state(${messageId}::UUID)
    `) as Row[])) as Row[];
    const state = rows[0]?.state as PaymentState;
    if (rows.length !== 1 || !PAYMENT_STATES.includes(state) || state === 'check_failed') return { state: 'check_failed', live: false, stop: false };
    return { state, live: rows[0]!.live === true, stop: false };
  } catch (err) {
    log.warn('Intercompany payment state check failed', { companyId, messageId, code: sqlstate(err) }, 'intercompany');
    return { state: 'check_failed', live: false, stop: STOP_CODES.has(sqlstate(err) ?? '') };
  }
}

/** Every row's word under one tighten-only 2 s bound (the caller's value put back after); after a timeout the rest are check_failed. */
export async function statesOf(companyId: string, ids: string[]): Promise<Map<string, { state: PaymentState; live: boolean }>> {
  const out = new Map<string, { state: PaymentState; live: boolean }>();
  if (ids.length === 0) return out;
  const bound = (await sql`
    SELECT prev, pg_catalog.set_config('lock_timeout', CASE WHEN prev::interval = interval '0' OR prev::interval > interval '2s' THEN '2s' ELSE prev END, true)
      FROM (SELECT pg_catalog.current_setting('lock_timeout') AS prev) s
  `) as Row[];
  let stopped = false;
  for (const id of ids) {
    if (stopped) { out.set(id, { state: 'check_failed', live: false }); continue; }
    const { stop, ...answer } = await stateOf(companyId, id);
    out.set(id, answer);
    stopped = stop;
  }
  await sql`SELECT pg_catalog.set_config('lock_timeout', ${String(bound[0]?.prev ?? '0')}, true)`;
  return out;
}

async function issuerInvoices(companyId: string, ids: string[]): Promise<Map<string, PaymentIssuerInvoice>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id, invoice_number, (total_amount - COALESCE(amount_paid, 0))::float8 AS open, status::text AS status,
           COALESCE(NULLIF(currency_code, ''), 'ZAR') AS currency, to_char(invoice_date, 'YYYY-MM-DD') AS date
      FROM customer_invoices WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND deleted_at IS NULL
  `) as Row[];
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), {
    id: String(r.id), number: String(r.invoice_number ?? ''), status: String(r.status ?? ''),
    openAmount: OPEN_INVOICE.has(String(r.status)) ? Number(r.open) : null, currency: String(r.currency), date: asText(r.date, 10),
  }]));
}

async function rowsOf(companyId: string, statuses: InboxStatus[] | null, messageId: string | null, limit: number, offset: number): Promise<Row[]> {
  return (await sql`
    SELECT m.id, m.status, m.connection_id, m.payload, m.reason, m.error, m.handled_at, m.created_at, m.target_doc_type, m.target_doc_id,
           to_char(c.cutover_date, 'YYYY-MM-DD') AS cutover, cu.name AS sender_name,
           t.id AS t_id, t.payment_number AS t_number, t.status AS t_status, (t.bank_reference = 'IC:' || m.id::TEXT AND t.status = 'draft') AS t_draft
      FROM intercompany_messages m
      LEFT JOIN intercompany_connections c ON c.id = m.connection_id AND (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
      LEFT JOIN intercompany_connection_sides s ON s.connection_id = m.connection_id AND s.company_id = ${companyId}::UUID
      LEFT JOIN customers cu ON cu.id = s.customer_id AND cu.company_id = ${companyId}::UUID
      LEFT JOIN customer_payments t ON m.target_doc_type = 'customer_payment' AND t.id = m.target_doc_id AND t.company_id = ${companyId}::UUID
     WHERE m.to_company_id = ${companyId}::UUID AND m.kind = 'payment' AND m.source_doc_type = 'payment_allocation'
       AND (${messageId}::UUID IS NULL OR m.id = ${messageId}::UUID)
       AND (${statuses}::TEXT[] IS NULL OR m.status = ANY(${statuses}::TEXT[]))
     ORDER BY m.created_at DESC, m.id
     LIMIT ${limit} OFFSET ${offset}
  `) as Row[];
}

interface Built { item: PaymentItem; payload: PaymentPayload | null; cutover: string | null }

async function build(companyId: string, rows: Row[]): Promise<Built[]> {
  const parsed = rows.map((r) => parsePaymentPayload(r.payload));
  const states = await statesOf(companyId, rows.map((r) => String(r.id)));
  const invoices = await issuerInvoices(companyId, [...new Set(parsed.flatMap((p) => (p.ok ? [p.payload.issuerDocument.id.toLowerCase()] : [])))]);
  return rows.map((r, i) => {
    const res = parsed[i]!;
    const p = res.ok ? res.payload : null;
    const st = states.get(String(r.id)) ?? { state: 'check_failed' as PaymentState, live: false };
    const item: PaymentItem = {
      id: String(r.id), status: String(r.status) as InboxStatus, connectionId: String(r.connection_id),
      senderName: asText(r.sender_name, 200) ?? 'Another company',
      paymentNumber: p?.payment.number ?? null, paymentReference: p?.payment.reference ?? null, paymentDate: p?.payment.date ?? null,
      paymentMethod: p?.payment.method ?? null, amount: p?.amount ?? null, currency: p?.currency ?? null,
      payerDocumentNumber: p?.payerDocument.number ?? null, payerDocumentDate: p?.payerDocument.date ?? null,
      issuerInvoice: p ? invoices.get(p.issuerDocument.id.toLowerCase()) ?? null : null,
      state: p ? st.state : 'check_failed', live: p ? st.live : false,
      reason: asText(r.reason), error: asText(r.error, 4000) ?? (res.ok ? null : res.error),
      handledAt: r.handled_at ? toIsoTimestamp(r.handled_at as Date | string) : null, createdAt: toIsoTimestamp(r.created_at as Date | string) ?? '',
      target: r.t_id ? { paymentId: String(r.t_id), paymentNumber: String(r.t_number ?? ''), status: String(r.t_status), isDraft: r.t_draft === true } : null,
    };
    return { item, payload: p, cutover: asText(r.cutover, 10) };
  });
}

export async function listPaymentInbox(companyId: string, filter: InboxFilter, limit: number, offset: number): Promise<PaymentPage> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 25, 1), INBOX_PAGE_MAX);
  const statuses = filter === 'handled' ? HANDLED : OPEN;
  const rows = await rowsOf(companyId, statuses, null, capped, Math.max(Math.trunc(offset) || 0, 0));
  const built = rows.length > 0 ? await build(companyId, rows) : [];
  const [c] = (await sql`
    SELECT count(*) FILTER (WHERE status = ANY(${statuses}::TEXT[]))::int AS total, count(*) FILTER (WHERE status = 'pending')::int AS open_count
      FROM intercompany_messages WHERE to_company_id = ${companyId}::UUID AND kind = 'payment' AND source_doc_type = 'payment_allocation'
  `) as Row[];
  return { items: built.map((b) => b.item), total: Number(c?.total ?? 0), openCount: Number(c?.open_count ?? 0), enabled: await loanClearingEnabled(companyId) };
}

/** One payment message of this company with its suggestions (an open message, the flag on). Another company's or another kind: 404. */
export async function loadPaymentDetail(companyId: string, messageId: string): Promise<PaymentDetail> {
  const rows = await rowsOf(companyId, null, messageId, 1, 0);
  if (rows.length === 0) throw new ConnectionRefusal(404, 'Message not found');
  const [b] = await build(companyId, rows);
  const enabled = await loanClearingEnabled(companyId);
  const suggestions = enabled && b!.payload && b!.item.status === 'pending'
    ? await suggestionsFor({ companyId, messageId, connectionId: b!.item.connectionId, payload: b!.payload }) : null;
  return { item: b!.item, allocationId: b!.payload?.allocationId ?? null, linkId: b!.payload?.linkId ?? null, cutoverDate: b!.cutover, enabled, suggestions };
}

/** The receipt chip (LOW-2): the payment message whose TARGET is this receipt (never the stamp alone), and its word; null when none. */
export async function receiptIcState(companyId: string, receiptId: string): Promise<{ messageId: string; state: PaymentState; status: string } | null> {
  const [m] = (await sql`
    SELECT id, status FROM intercompany_messages
     WHERE to_company_id = ${companyId}::UUID AND kind = 'payment' AND status = 'accepted'
       AND target_doc_type = 'customer_payment' AND target_doc_id = ${receiptId}::UUID
     ORDER BY created_at, id LIMIT 1
  `) as Row[];
  if (!m) return null;
  const st = (await statesOf(companyId, [String(m.id)])).get(String(m.id))!;
  return { messageId: String(m.id), state: st.state, status: String(m.status) };
}
