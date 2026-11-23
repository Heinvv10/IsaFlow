/**
 * The RECEIVER's allocation inbox (intercompany P4-C): the `allocation` messages a payer in the group sent THIS company (its cash applied to
 * the bill that is linked to one of this company's customer invoices). READ ONLY: nothing here writes a journal, a document or a message
 * (reject and dismiss are `handleService`'s guarded transitions; clearing is D's).
 *
 * Runs on the request's transaction, so RLS already limits every row to the session company; `to_company_id` / `company_id` are named in each
 * query too. Each item carries the payload's facts (display text only, never an identity), this company's OWN issuer invoice looked up by the
 * payload's id under this company, the database's liveness answer and a derived mismatch that is never stored. The liveness answer
 * (`intercompany_allocation_message_live`) is asked only for an OPEN (pending / failed) message, one call per message in its own savepoint;
 * a handled one is `not_pending` without asking. The page's lock wait is bounded once (tighten-only 2 s, put back after the checks) and the
 * first failure ends the asking: the rest of the page is `check_failed`, so a page waits at most once. Never a throw, never a poisoned
 * transaction. The answer is advisory: D asks again under its own locks before acting.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { toIsoTimestamp } from '@/lib/dateUtils';
import { ConnectionRefusal } from './connectionTypes';
import { parseMirrorPayload, type AllocationPayload } from './mirrorPayload';
import { INBOX_PAGE_MAX } from './inboxRead';
import type { InboxFilter, InboxStatus } from './inboxTypes';
import {
  ALLOCATION_LIVE_REASONS, type AllocationDetail, type AllocationIssuerInvoice, type AllocationItem, type AllocationLiveReason,
  type AllocationMismatch, type AllocationPage,
} from './allocationInboxTypes';

type Row = Record<string, unknown>;

const OPEN: InboxStatus[] = ['pending', 'failed'];
const HANDLED: InboxStatus[] = ['accepted', 'rejected', 'dismissed', 'withdrawn'];

const cents = (n: number): number => Math.round(n * 100);
const asText = (v: unknown, max = 2000): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const sqlstate = (err: unknown): string | null => (err as { code?: string } | null)?.code ?? null;

/** The invoice statuses something is still owed on (the ageing's): a draft, one awaiting approval, a paid or a cancelled one is not open. */
const OPEN_INVOICE = new Set(['approved', 'sent', 'partially_paid', 'overdue']);

/**
 * What does not fit between the payment and this company's invoice, first that applies: the invoice is gone (or cancelled), it is not open,
 * the payment is not in ZAR or not in the invoice's currency, the payment or the invoice is dated before the connection's cut-over, the
 * amount is above the invoice's open amount. Null for an unreadable payload (it carries no figure to compare) and when everything fits.
 */
export function allocationMismatch(p: AllocationPayload | null, invoice: AllocationIssuerInvoice | null, cutover: string | null): AllocationMismatch | null {
  if (!p) return null;
  if (!invoice || invoice.status === 'cancelled') return 'invoice_gone';
  if (invoice.openAmount === null) return 'invoice_not_open';
  if (p.currency !== 'ZAR' || p.currency !== invoice.currency.toUpperCase()) return 'currency';
  if (cutover && p.payment.date < cutover) return 'pre_cutover_payment';
  if (cutover && invoice.date && invoice.date < cutover) return 'pre_cutover_invoice';
  if (cents(p.amount) > cents(invoice.openAmount)) return 'amount_exceeds_open';
  return null;
}

type Live = { live: boolean; liveReason: AllocationLiveReason };
const FAILED: Live = { live: false, liveReason: 'check_failed' };

/** The database's answer for one message, in a savepoint of its own (a failed call must not poison the request's transaction). `threw`: the
 *  call itself failed (a lock wait that ran out, a refusal), so the page stops asking. */
async function liveOf(companyId: string, messageId: string): Promise<Live & { threw: boolean }> {
  try {
    const rows = (await withSavepoint('intercompany_allocation_live', async () => (await sql`
      SELECT live, reason FROM public.intercompany_allocation_message_live(${messageId}::UUID)
    `) as Row[])) as Row[];
    const reason = rows[0]?.reason;
    const known = ALLOCATION_LIVE_REASONS.includes(reason as AllocationLiveReason) && reason !== 'check_failed';
    if (rows.length !== 1 || !known || (rows[0]!.live === true) !== (reason === 'ok')) return { ...FAILED, threw: false };
    return { live: reason === 'ok', liveReason: reason as AllocationLiveReason, threw: false };
  } catch (err) {
    // the code only: a database message names ids
    log.warn('Intercompany allocation liveness check failed', { companyId, messageId, code: sqlstate(err) }, 'intercompany');
    return { ...FAILED, threw: true };
  }
}

/**
 * The answers for a page: handled rows `not_pending` without a call; the open ones asked in order under ONE tighten-only 2 s lock bound (the
 * caller's value put back after, outside every savepoint, so no savepoint rollback can undo either), and after the first failed call the rest
 * `check_failed` without another call.
 */
async function livesOf(companyId: string, rows: Row[]): Promise<Live[]> {
  const open = rows.filter((r) => OPEN.includes(String(r.status) as InboxStatus));
  if (open.length === 0) return rows.map(() => ({ live: false, liveReason: 'not_pending' }));
  const bound = (await sql`
    SELECT prev, pg_catalog.set_config('lock_timeout', CASE WHEN prev::interval = interval '0' OR prev::interval > interval '2s' THEN '2s' ELSE prev END, true)
      FROM (SELECT pg_catalog.current_setting('lock_timeout') AS prev) s
  `) as Row[];
  const answers = new Map<string, Live>();
  try {
    let failed = false;
    for (const r of open) {
      if (failed) { answers.set(String(r.id), FAILED); continue; }
      const { threw, ...answer } = await liveOf(companyId, String(r.id));
      answers.set(String(r.id), answer);
      failed = threw;
    }
  } finally {
    await sql`SELECT pg_catalog.set_config('lock_timeout', ${String(bound[0]?.prev ?? '0')}, true)`;
  }
  return rows.map((r) => answers.get(String(r.id)) ?? { live: false, liveReason: 'not_pending' });
}

/** This company's own customer invoices by id (none of another company's, whatever the payload names). */
async function issuerInvoices(companyId: string, ids: string[]): Promise<Map<string, AllocationIssuerInvoice>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id, invoice_number, (total_amount - COALESCE(amount_paid, 0))::float8 AS open, status::text AS status,
           COALESCE(NULLIF(currency_code, ''), 'ZAR') AS currency, invoice_date::text AS date
      FROM customer_invoices
     WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND deleted_at IS NULL
  `) as Row[];
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), {
    id: String(r.id), number: String(r.invoice_number ?? ''), status: String(r.status ?? ''),
    openAmount: OPEN_INVOICE.has(String(r.status)) ? Number(r.open) : null,
    currency: String(r.currency), date: asText(r.date, 10),
  }]));
}

interface Built { item: AllocationItem; payload: AllocationPayload | null; cutover: string | null }

/** The rows as items: every liveness check first, then this company's invoices. */
async function build(companyId: string, rows: Row[]): Promise<Built[]> {
  const parsed = rows.map((r) => parseMirrorPayload(r.payload, 'allocation', String(r.from_company_id)));
  const lives = await livesOf(companyId, rows);
  const ids = [...new Set(parsed.flatMap((p) => (p.ok ? [p.payload.issuerDocument.id.toLowerCase()] : [])))];
  const invoices = await issuerInvoices(companyId, ids);
  return rows.map((r, i) => {
    const res = parsed[i]!;
    const p = res.ok ? res.payload : null;
    const invoice = p ? invoices.get(p.issuerDocument.id.toLowerCase()) ?? null : null;
    const cutover = asText(r.cutover, 10);
    const item: AllocationItem = {
      id: String(r.id), status: String(r.status) as InboxStatus, connectionId: String(r.connection_id),
      senderName: asText(r.sender_name, 200) ?? 'Another company',
      paymentNumber: p?.payment.number ?? null, paymentDate: p?.payment.date ?? null, paymentMethod: p?.payment.method ?? null,
      paymentReference: p?.payment.reference ?? null, amount: p?.amount ?? null, currency: p?.currency ?? null,
      payerDocumentNumber: p?.payerDocument.number ?? null, cashLegIsLoanAccount: p?.payment.cashLegIsLoanAccount ?? null,
      issuerInvoice: invoice, ...lives[i]!, mismatch: allocationMismatch(p, invoice, cutover),
      blocker: res.ok ? null : res.error, reason: asText(r.reason), error: asText(r.error, 4000),
      handledAt: r.handled_at ? toIsoTimestamp(r.handled_at as Date | string) : null,
      createdAt: toIsoTimestamp(r.created_at as Date | string) ?? '',
    };
    return { item, payload: p, cutover };
  });
}

/** How many allocation messages to this company have these statuses (the page's total), and how many are open (pending / failed). */
async function countsOf(companyId: string, statuses: InboxStatus[]): Promise<{ total: number; open: number }> {
  const rows = (await sql`
    SELECT count(*) FILTER (WHERE status = ANY(${statuses}::TEXT[]))::int AS total, count(*) FILTER (WHERE status = ANY(${OPEN}::TEXT[]))::int AS open_count
      FROM intercompany_messages WHERE to_company_id = ${companyId}::UUID AND kind = 'allocation'
  `) as Row[];
  return { total: Number(rows[0]?.total ?? 0), open: Number(rows[0]?.open_count ?? 0) };
}

/** The message rows, with this company's own name for the payer (its side's customer) and the connection's cut-over. */
async function rowsOf(companyId: string, statuses: InboxStatus[] | null, messageId: string | null, limit: number, offset: number): Promise<Row[]> {
  return (await sql`
    SELECT m.id, m.status, m.connection_id, m.from_company_id, m.payload, m.reason, m.error, m.handled_at, m.created_at,
           c.cutover_date::text AS cutover, cu.name AS sender_name
      FROM intercompany_messages m
      LEFT JOIN intercompany_connections c ON c.id = m.connection_id AND (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
      LEFT JOIN intercompany_connection_sides s ON s.connection_id = m.connection_id AND s.company_id = ${companyId}::UUID
      LEFT JOIN customers cu ON cu.id = s.customer_id AND cu.company_id = ${companyId}::UUID
     WHERE m.to_company_id = ${companyId}::UUID AND m.kind = 'allocation'
       AND (${messageId}::UUID IS NULL OR m.id = ${messageId}::UUID)
       AND (${statuses}::TEXT[] IS NULL OR m.status = ANY(${statuses}::TEXT[]))
     ORDER BY m.created_at DESC, m.id
     LIMIT ${limit} OFFSET ${offset}
  `) as Row[];
}

export async function listAllocationInbox(companyId: string, filter: InboxFilter, limit: number, offset: number): Promise<AllocationPage> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 25, 1), INBOX_PAGE_MAX);
  const skip = Math.max(Math.trunc(offset) || 0, 0);
  const statuses = filter === 'handled' ? HANDLED : OPEN;
  const rows = await rowsOf(companyId, statuses, null, capped, skip);
  const built = rows.length > 0 ? await build(companyId, rows) : [];
  // counted on their own: a page past the last one still says how many there are
  const counts = await countsOf(companyId, statuses);
  return { items: built.map((b) => b.item), total: counts.total, allocationCount: counts.open };
}

/** One allocation message of this company, with the payload's facts. A message that is not this company's allocation is a 404. */
export async function loadAllocationDetail(companyId: string, messageId: string): Promise<AllocationDetail> {
  const rows = await rowsOf(companyId, null, messageId, 1, 0);
  if (rows.length === 0) throw new ConnectionRefusal(404, 'Message not found');
  const [b] = await build(companyId, rows);
  const p = b!.payload;
  return { item: b!.item, allocationId: p?.allocationId ?? null, linkId: p?.linkId ?? null, linkOrigin: p?.linkOrigin ?? null, cutoverDate: b!.cutover };
}

/** One allocation message of this company, raw (id, status), or null: what reject / dismiss check first. Never an invoice message. */
export async function loadAllocationRow(companyId: string, messageId: string): Promise<Row | null> {
  const rows = (await sql`
    SELECT id, status FROM intercompany_messages WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'allocation'
  `) as Row[];
  return rows[0] ?? null;
}
