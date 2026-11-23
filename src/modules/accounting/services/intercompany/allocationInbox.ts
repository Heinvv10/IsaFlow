/**
 * The RECEIVER's allocation inbox (intercompany P4-C): the `allocation` messages a payer in the group sent THIS company (its cash applied to
 * the bill that is linked to one of this company's customer invoices). READ ONLY: nothing here writes a journal, a document or a message
 * (reject and dismiss are `handleService`'s guarded transitions; clearing is D's).
 *
 * Runs on the request's transaction, so RLS already limits every row to the session company; `to_company_id` / `company_id` are named in each
 * query too. Each item carries the payload's facts (display text only, never an identity), this company's OWN issuer invoice looked up by the
 * payload's id under this company, the database's liveness answer (`intercompany_allocation_message_live`, one call per item in its own
 * savepoint: a failure is `check_failed`, never a throw, never a poisoned transaction) and a derived mismatch that is never stored.
 * The liveness answer is advisory: D asks again under its own locks before acting.
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

/**
 * What does not fit between the payment and this company's invoice, first that applies: the invoice is gone (or cancelled), the payment is
 * not in ZAR or not in the invoice's currency, the invoice is dated before the connection's cut-over, the amount is above the invoice's open
 * amount. Null for an unreadable payload (it carries no figure to compare) and when everything fits.
 */
export function allocationMismatch(p: AllocationPayload | null, invoice: AllocationIssuerInvoice | null, cutover: string | null): AllocationMismatch | null {
  if (!p) return null;
  if (!invoice || invoice.status === 'cancelled') return 'invoice_gone';
  if (p.currency !== 'ZAR' || p.currency !== invoice.currency.toUpperCase()) return 'currency';
  if (cutover && invoice.date && invoice.date < cutover) return 'pre_cutover_invoice';
  if (cents(p.amount) > cents(invoice.openAmount)) return 'amount_exceeds_open';
  return null;
}

/** The database's answer for one message, in a savepoint of its own (a failed call must not poison the request's transaction). */
async function liveOf(companyId: string, messageId: string): Promise<{ live: boolean; liveReason: AllocationLiveReason }> {
  try {
    const rows = (await withSavepoint('intercompany_allocation_live', async () => (await sql`
      SELECT live, reason FROM public.intercompany_allocation_message_live(${messageId}::UUID)
    `) as Row[])) as Row[];
    const reason = rows[0]?.reason;
    const known = ALLOCATION_LIVE_REASONS.includes(reason as AllocationLiveReason) && reason !== 'check_failed';
    if (rows.length !== 1 || !known || (rows[0]!.live === true) !== (reason === 'ok')) return { live: false, liveReason: 'check_failed' };
    return { live: reason === 'ok', liveReason: reason as AllocationLiveReason };
  } catch (err) {
    // the code only: a database message names ids
    log.warn('Intercompany allocation liveness check failed', { companyId, messageId, code: sqlstate(err) }, 'intercompany');
    return { live: false, liveReason: 'check_failed' };
  }
}

/** This company's own customer invoices by id (none of another company's, whatever the payload names). */
async function issuerInvoices(companyId: string, ids: string[]): Promise<Map<string, AllocationIssuerInvoice>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id, invoice_number, (total_amount - COALESCE(amount_paid, 0))::float8 AS open, status,
           COALESCE(NULLIF(currency_code, ''), 'ZAR') AS currency, invoice_date::text AS date
      FROM customer_invoices
     WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND deleted_at IS NULL
  `) as Row[];
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), {
    id: String(r.id), number: String(r.invoice_number ?? ''), openAmount: Number(r.open), status: String(r.status ?? ''),
    currency: String(r.currency), date: asText(r.date, 10),
  }]));
}

interface Built { item: AllocationItem; payload: AllocationPayload | null; cutover: string | null }

/** The rows as items: every liveness check first (each in its own savepoint), then this company's invoices. */
async function build(companyId: string, rows: Row[]): Promise<Built[]> {
  const parsed = rows.map((r) => parseMirrorPayload(r.payload, 'allocation', String(r.from_company_id)));
  const lives: Array<{ live: boolean; liveReason: AllocationLiveReason }> = [];
  for (const r of rows) lives.push(await liveOf(companyId, String(r.id)));
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

/** Pending and failed allocation messages to this company. */
export async function openAllocationCount(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n FROM intercompany_messages
     WHERE to_company_id = ${companyId}::UUID AND kind = 'allocation' AND status = ANY(${OPEN}::TEXT[])
  `) as Row[];
  return Number(rows[0]?.n ?? 0);
}

/** The message rows, with this company's own name for the payer (its side's customer) and the connection's cut-over. */
async function rowsOf(companyId: string, statuses: InboxStatus[] | null, messageId: string | null, limit: number, offset: number): Promise<Row[]> {
  return (await sql`
    SELECT m.id, m.status, m.connection_id, m.from_company_id, m.payload, m.reason, m.error, m.handled_at, m.created_at,
           c.cutover_date::text AS cutover, cu.name AS sender_name, count(*) OVER ()::int AS total
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
  const rows = await rowsOf(companyId, filter === 'handled' ? HANDLED : OPEN, null, capped, skip);
  const built = rows.length > 0 ? await build(companyId, rows) : [];
  return { items: built.map((b) => b.item), total: Number(rows[0]?.total ?? 0), allocationCount: await openAllocationCount(companyId) };
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
