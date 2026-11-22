/**
 * The purchase-order status report (design docs/design/mcp-po-reports.md, `po_status_report`): per PO what was ordered, received,
 * billed, is outstanding and is committed, with its age, the days since the last receipt and bill, and the bills that tie it.
 * Every figure comes from a reader that already exists, so it cannot disagree with them:
 *   - billed: `purchaseOrderBilled.billedCentsByPo`, the attribution `get_purchase_order` and fully_billed use (lines first, then the
 *     link, then the capped header fallback; `budgets/billAttribution`);
 *   - committed: `purchaseOrderBillingClose.poCommittedCents`, the per-line engine budget_remaining and committed_spend read (0 for a PO
 *     that does not commit);
 *   - received: sum over lines of min(quantity_received, quantity) x unit_price. `po_items.quantity_received` is what a goods received
 *     note adds and a cancel takes back (get_purchase_order reports the same column), so a cancelled note is already out of it; the
 *     last receipt date ignores cancelled notes the same way.
 * ordered is the ex-VAT sum of the lines (`line_total`); outstanding is ordered less billed, floored at 0. Money is integer cents.
 * po_items, grn_items and the bill links are reached through the company's PO; every query names company_id.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { BILLED_STATUSES } from '../budgets/remainingCommitted';
import { billTies, type BillTie } from '../budgets/billAttribution';
import { billedCentsByPo } from './purchaseOrderBilled';
import { poCommittedCents } from './purchaseOrderBillingClose';

export const BILLS_SHOWN = 10;
/** `only_outstanding` needs every candidate's billed figure before it can page: past this many it asks for narrower filters. */
export const MAX_OUTSTANDING_SCAN = 2000;

export class PoReportScanError extends Error {
  constructor() {
    super(`More than ${MAX_OUTSTANDING_SCAN} purchase orders match: narrow the filters (status, supplier_id, from / to, older_than_days) to use only_outstanding`);
  }
}

export interface PoStatusQuery {
  statuses: readonly string[] | null;
  supplierId: string | null;
  /** Order date window, 'YYYY-MM-DD', inclusive. */
  from: string | null;
  to: string | null;
  /** Only POs older than this many days (age_days > it). */
  olderThanDays: number | null;
  onlyOutstanding: boolean;
  offset: number;
  limit: number;
}

export interface PoStatusBill {
  billId: string;
  number: string;
  status: string;
  /** How the bill holds the PO: its lines name one of the PO's lines, a link row, or only its header (`billAttribution`). */
  via: BillTie['via'];
  attributedCents: number;
  /** 'YYYY-MM-DD'. */
  date: string | null;
  countsAsBilled: boolean;
  deleted: boolean;
}

export interface PoStatusRow {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string | null;
  status: string;
  closedFromStatus: string | null;
  closedByBilling: boolean;
  orderDate: string;
  ageDays: number;
  orderedCents: number;
  receivedCents: number;
  billedCents: number;
  outstandingCents: number;
  committedCents: number;
  lastReceiptDate: string | null;
  daysSinceLastReceipt: number | null;
  lastBillDate: string | null;
  daysSinceLastBill: number | null;
  bills: PoStatusBill[];
  billsTotal: number;
}

export interface PoStatusReport { rows: PoStatusRow[]; total: number; nextOffset: number | null; asOf: string }

const lower = (v: unknown): string => String(v).toLowerCase();
const day = (v: unknown): string | null => (v == null ? null : String(v).slice(0, 10));
const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/** The page of POs in report order (oldest first, then number) with what the PO's own lines say; `count` is the unpaged total. */
async function candidates(companyId: string, q: PoStatusQuery, today: string, all: boolean): Promise<Array<DbRow & { count: number }>> {
  const statuses = q.statuses === null ? null : [...q.statuses];
  return (await sql`
    SELECT po.id::TEXT AS id, po.po_number, po.supplier_id::TEXT AS supplier_id, s.name AS supplier_name, po.status, po.closed_from_status,
           (po.status = 'closed' AND po.closed_by_billing) AS closed_by_billing, to_char(po.order_date, 'YYYY-MM-DD') AS order_date,
           (${today}::DATE - po.order_date)::INT AS age_days,
           (SELECT COALESCE(SUM(round(x.line_total * 100)), 0)::BIGINT FROM po_items x WHERE x.purchase_order_id = po.id) AS ordered_cents,
           (SELECT COALESCE(SUM(round(LEAST(COALESCE(x.quantity_received, 0), x.quantity) * x.unit_price * 100)), 0)::BIGINT
              FROM po_items x WHERE x.purchase_order_id = po.id) AS received_cents,
           count(*) OVER ()::INT AS count
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
     WHERE po.company_id = ${companyId}::UUID
       AND (${statuses}::TEXT[] IS NULL OR po.status = ANY(${statuses}::TEXT[]))
       AND (${q.supplierId}::UUID IS NULL OR po.supplier_id = ${q.supplierId}::UUID)
       AND (${q.from}::DATE IS NULL OR po.order_date >= ${q.from}::DATE)
       AND (${q.to}::DATE IS NULL OR po.order_date <= ${q.to}::DATE)
       AND (${q.olderThanDays}::INT IS NULL OR (${today}::DATE - po.order_date) > ${q.olderThanDays}::INT)
     ORDER BY po.order_date, po.po_number, po.id
     LIMIT ${all ? MAX_OUTSTANDING_SCAN + 1 : q.limit} OFFSET ${all ? 0 : q.offset}
  `) as Array<DbRow & { count: number }>;
}

async function lastReceipts(companyId: string, poIds: readonly string[]): Promise<Map<string, string>> {
  if (poIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT g.purchase_order_id::TEXT AS po, to_char(max(g.received_date), 'YYYY-MM-DD') AS last
      FROM goods_received_notes g
     WHERE g.company_id = ${companyId}::UUID AND g.purchase_order_id = ANY(${[...poIds]}::UUID[]) AND g.status <> 'cancelled'
     GROUP BY g.purchase_order_id
  `) as DbRow[];
  return new Map(rows.map((r) => [lower(r.po), String(r.last)]));
}

/** The bills tying each PO by the attribution, with their number, status and date (company-scoped), oldest first. */
async function billsByPo(companyId: string, poIds: readonly string[]): Promise<Map<string, PoStatusBill[]>> {
  const ties = await billTies(companyId, poIds, { statuses: null });
  const out = new Map<string, PoStatusBill[]>();
  if (ties.length === 0) return out;
  const heads = (await sql`
    SELECT id::TEXT AS id, invoice_number, to_char(invoice_date, 'YYYY-MM-DD') AS date
      FROM supplier_invoices WHERE company_id = ${companyId}::UUID AND id = ANY(${[...new Set(ties.map((t) => t.billId))]}::UUID[])
  `) as DbRow[];
  const head = new Map(heads.map((h) => [lower(h.id), h]));
  for (const t of ties) {
    const h = head.get(t.billId);
    out.set(t.poId, [...(out.get(t.poId) ?? []), {
      billId: t.billId, number: String(h?.invoice_number ?? ''), status: t.status, via: t.via, attributedCents: t.cents, date: day(h?.date),
      countsAsBilled: (BILLED_STATUSES as readonly string[]).includes(t.status) && !t.deleted, deleted: t.deleted,
    }]);
  }
  for (const list of out.values()) list.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.number.localeCompare(b.number) || a.billId.localeCompare(b.billId));
  return out;
}

export async function readPoStatusReport(companyId: string, q: PoStatusQuery, today: string = todayInSast()): Promise<PoStatusReport> {
  const scan = q.onlyOutstanding;
  let rows = await candidates(companyId, q, today, scan);
  if (scan && rows.length > MAX_OUTSTANDING_SCAN) throw new PoReportScanError();
  let total = rows[0] ? Number(rows[0].count) : 0;
  const ids = (rs: readonly DbRow[]) => rs.map((r) => String(r.id));
  const billed = await billedCentsByPo(companyId, ids(rows));
  const outstanding = (r: DbRow) => Math.max(0, Number(r.ordered_cents) - (billed.get(lower(r.id)) ?? 0));
  if (scan) {
    rows = rows.filter((r) => outstanding(r) > 0);
    total = rows.length;
    rows = rows.slice(q.offset, q.offset + q.limit);
  }
  const page = ids(rows);
  const [committed, receipts, bills] = await Promise.all([poCommittedCents(companyId, page), lastReceipts(companyId, page), billsByPo(companyId, page)]);
  const todayNumber = dayNumber(today);
  return {
    asOf: today,
    total,
    nextOffset: q.offset + rows.length < total ? q.offset + rows.length : null,
    rows: rows.map((r) => {
      const id = lower(r.id);
      const all = bills.get(id) ?? [];
      const lastBill = all.filter((b) => b.countsAsBilled && b.date !== null).map((b) => b.date as string).sort().pop() ?? null;
      const lastReceipt = receipts.get(id) ?? null;
      const billedCents = billed.get(id) ?? 0;
      return {
        id, poNumber: String(r.po_number), supplierId: String(r.supplier_id), supplierName: r.supplier_name == null ? null : String(r.supplier_name),
        status: String(r.status), closedFromStatus: r.closed_from_status == null ? null : String(r.closed_from_status), closedByBilling: r.closed_by_billing === true,
        orderDate: String(r.order_date), ageDays: Number(r.age_days),
        orderedCents: Number(r.ordered_cents), receivedCents: Number(r.received_cents), billedCents,
        outstandingCents: Math.max(0, Number(r.ordered_cents) - billedCents), committedCents: committed.get(id) ?? 0,
        lastReceiptDate: lastReceipt, daysSinceLastReceipt: lastReceipt === null ? null : todayNumber - dayNumber(lastReceipt),
        lastBillDate: lastBill, daysSinceLastBill: lastBill === null ? null : todayNumber - dayNumber(lastBill),
        bills: all.slice(0, BILLS_SHOWN), billsTotal: all.length,
      };
    }),
  };
}
