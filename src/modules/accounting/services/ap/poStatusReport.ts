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
 * ordered is the PO's billing basis (`remainingCommitted.poBillingBasisCents`: the larger of the header subtotal and the ex-VAT sum of the lines,
 * what get_purchase_order's outstanding_to_bill and #1703's fully-billed rule measure against); outstanding is ordered less billed, floored at 0.
 * Today is the database's Johannesburg calendar day, read in the request's own transaction, and is returned as `asOf`. Money is integer cents.
 * The bill list leaves out a bill that is soft-deleted or cancelled: it ties nothing. Named limit: a bill that names the PO only in its header is
 * listed whenever the attribution holds it (same supplier), even where the link tool could not link the pair (get_purchase_order lists only a
 * header the link tool could link), so the two bill lists can differ for such a bill.
 * po_items, grn_items and the bill links are reached through the company's PO; every query names company_id.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { BILLED_STATUSES, poBillingBasisCents } from '../budgets/remainingCommitted';
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
  /** Only POs with something still to bill on a live order (`LIVE_BILLING_STATUSES`) and outstanding above 0. */
  onlyOutstanding: boolean;
  /** False for a role that may not read committed (it is then null in every row). */
  includeCommitted: boolean;
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
  /** null: the caller's role may not see it (owners, admins and managers only, as budget_remaining's committed). */
  committedCents: number | null;
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

/** PO statuses that still have something to bill on a live order: only_outstanding is read within them (a closed, cancelled or draft PO is not). */
export const LIVE_BILLING_STATUSES = ['approved', 'partially_received', 'received'] as const;

/**
 * Goods received note statuses that hold goods: a note the app writes is 'received' and adds its quantities to po_items.quantity_received
 * (goodsReceivedService writes no other status); 'inspected' and 'accepted' are later states of such a note. A 'draft' or 'rejected' note
 * holds none, and a cancelled one has been taken back.
 */
export const RECEIVED_NOTE_STATUSES = ['received', 'inspected', 'accepted'] as const;

/**
 * The page of POs in report order (oldest first, then number) with what the PO's own lines say. `count` is the filter's true total on
 * every row, and on the ONE row an empty page still returns (its other columns null: an offset past the end must not read as no POs).
 * received_cents prices each line pro rata from its stored line_total (round(line_total x min(received, ordered) / ordered)), so a fully
 * received line is its line_total to the cent whatever qty x price rounds to.
 */
async function candidates(companyId: string, q: PoStatusQuery, today: string, all: boolean): Promise<Array<DbRow & { count: number }>> {
  const statuses = q.statuses === null ? null : [...q.statuses];
  const rows = (await sql`
    WITH f AS (
      SELECT po.id, po.po_number, po.supplier_id, s.name AS supplier_name, po.status, po.closed_from_status, po.closed_by_billing, po.order_date
        FROM purchase_orders po
        LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
       WHERE po.company_id = ${companyId}::UUID
         AND (${statuses}::TEXT[] IS NULL OR po.status = ANY(${statuses}::TEXT[]))
         AND (NOT ${q.onlyOutstanding}::BOOLEAN OR po.status = ANY(${[...LIVE_BILLING_STATUSES]}::TEXT[]))
         AND (${q.supplierId}::UUID IS NULL OR po.supplier_id = ${q.supplierId}::UUID)
         AND (${q.from}::DATE IS NULL OR po.order_date >= ${q.from}::DATE)
         AND (${q.to}::DATE IS NULL OR po.order_date <= ${q.to}::DATE)
         AND (${q.olderThanDays}::INT IS NULL OR (${today}::DATE - po.order_date) > ${q.olderThanDays}::INT)
    ), n AS (SELECT count(*)::INT AS n FROM f)
    SELECT p.id::TEXT AS id, p.po_number, p.supplier_id::TEXT AS supplier_id, p.supplier_name, p.status, p.closed_from_status,
           (p.status = 'closed' AND p.closed_by_billing) AS closed_by_billing, to_char(p.order_date, 'YYYY-MM-DD') AS order_date,
           (${today}::DATE - p.order_date)::INT AS age_days,
           (SELECT COALESCE(SUM(round(x.line_total * LEAST(COALESCE(x.quantity_received, 0), x.quantity) / x.quantity * 100)), 0)::BIGINT  -- quantity > 0: po_items_quantity_check
              FROM po_items x WHERE x.purchase_order_id = p.id) AS received_cents,
           n.n AS count
      FROM n
      LEFT JOIN (SELECT * FROM f ORDER BY order_date, po_number, id LIMIT ${all ? MAX_OUTSTANDING_SCAN + 1 : q.limit} OFFSET ${all ? 0 : q.offset}) p ON true
     ORDER BY p.order_date, p.po_number, p.id
  `) as Array<DbRow & { count: number }>;
  return rows;
}

async function lastReceipts(companyId: string, poIds: readonly string[]): Promise<Map<string, string>> {
  if (poIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT g.purchase_order_id::TEXT AS po, to_char(max(g.received_date), 'YYYY-MM-DD') AS last
      FROM goods_received_notes g
     WHERE g.company_id = ${companyId}::UUID AND g.purchase_order_id = ANY(${[...poIds]}::UUID[]) AND g.status = ANY(${[...RECEIVED_NOTE_STATUSES]}::TEXT[])
     GROUP BY g.purchase_order_id
  `) as DbRow[];
  return new Map(rows.map((r) => [lower(r.po), String(r.last)]));
}

/** The live bills tying each PO by the attribution (never a soft-deleted or cancelled one), with number, status and date (company-scoped), newest first. */
async function billsByPo(companyId: string, poIds: readonly string[]): Promise<Map<string, PoStatusBill[]>> {
  const ties = (await billTies(companyId, poIds, { statuses: null })).filter((t) => !t.deleted && t.status !== 'cancelled');
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
      countsAsBilled: (BILLED_STATUSES as readonly string[]).includes(t.status),
    }]);
  }
  // Newest first (invoice date, then id, both descending): the ten shown are the most recent; bills_total counts them all.
  for (const list of out.values()) list.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.billId.localeCompare(a.billId));
  return out;
}

/** The Johannesburg calendar day, from the database clock (the transaction's start): what the report's ages are measured to. */
async function databaseToday(): Promise<string> {
  const row = ((await sql`SELECT to_char((now() AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') AS today`) as DbRow[])[0];
  return String(row?.today);
}

export async function readPoStatusReport(companyId: string, q: PoStatusQuery, today?: string): Promise<PoStatusReport> {
  const asOf = today ?? await databaseToday();
  const scan = q.onlyOutstanding;
  const fetched = await candidates(companyId, q, asOf, scan);
  // An empty page still answers one row (id null) carrying the filter's true count.
  let total = fetched[0] ? Number(fetched[0].count) : 0;
  let rows = fetched.filter((r) => r.id != null);
  if (scan && rows.length > MAX_OUTSTANDING_SCAN) throw new PoReportScanError();
  const ids = (rs: readonly DbRow[]) => rs.map((r) => String(r.id));
  const billed = await billedCentsByPo(companyId, ids(rows));
  const basis = await poBillingBasisCents(companyId, ids(rows));
  const ordered = (r: DbRow) => basis.get(lower(r.id)) ?? 0;
  const outstanding = (r: DbRow) => Math.max(0, ordered(r) - (billed.get(lower(r.id)) ?? 0));
  if (scan) {
    rows = rows.filter((r) => outstanding(r) > 0);
    total = rows.length;
    rows = rows.slice(q.offset, q.offset + q.limit);
  }
  const page = ids(rows);
  const [committed, receipts, bills] = await Promise.all([
    q.includeCommitted ? poCommittedCents(companyId, page) : Promise.resolve(null), lastReceipts(companyId, page), billsByPo(companyId, page),
  ]);
  const todayNumber = dayNumber(asOf);
  return {
    asOf,
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
        orderedCents: ordered(r), receivedCents: Number(r.received_cents), billedCents,
        outstandingCents: outstanding(r), committedCents: committed === null ? null : committed.get(id) ?? 0,
        lastReceiptDate: lastReceipt, daysSinceLastReceipt: lastReceipt === null ? null : todayNumber - dayNumber(lastReceipt),
        lastBillDate: lastBill, daysSinceLastBill: lastBill === null ? null : todayNumber - dayNumber(lastBill),
        bills: all.slice(0, BILLS_SHOWN), billsTotal: all.length,
      };
    }),
  };
}
