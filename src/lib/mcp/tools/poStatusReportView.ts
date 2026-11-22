/**
 * The wire shape of one po_status_report row (design docs/design/mcp-po-reports.md): money as decimal text from integer cents, free
 * text clipped (a supplier's name, a bill's number are the longest fields), at most BILLS_SHOWN bills with bills_total beside them.
 * Pure, so the worst-case page (every text at its cap, ten bills a PO, every date and amount at its widest) is measured against
 * MAX_READ_RESULT_BYTES without a database (tests/unit/mcp/poReportsTools.test.ts).
 */
import type { PoStatusBill, PoStatusRow } from '@/modules/accounting/services/ap/poStatusReport';
import { centsText } from './budgetToolArgs';

/** A page of the widest rows stays well under MAX_READ_RESULT_BYTES (measured in poReportsTools.test.ts). */
export const PO_REPORT_LIMIT_DEFAULT = 15;
export const PO_REPORT_LIMIT_MAX = 20;
const TEXT_CAP = 60;

const short = (v: string | null): string | null => (v === null ? null : v.slice(0, TEXT_CAP));

const billView = (b: PoStatusBill) => ({
  bill_id: b.billId, invoice_number: short(b.number), status: b.status, attributed_via: b.via, attributed_amount: centsText(b.attributedCents),
  invoice_date: b.date, counts_as_billed: b.countsAsBilled, deleted: b.deleted,
});

export const poStatusItem = (r: PoStatusRow) => ({
  id: r.id, po_number: short(r.poNumber), supplier: { id: r.supplierId, name: short(r.supplierName) },
  status: r.status, closed_from_status: r.closedFromStatus, closed_by_billing: r.closedByBilling,
  order_date: r.orderDate, age_days: r.ageDays,
  ordered: centsText(r.orderedCents), received: centsText(r.receivedCents), billed: centsText(r.billedCents),
  outstanding: centsText(r.outstandingCents), committed: centsText(r.committedCents),
  last_receipt_date: r.lastReceiptDate, days_since_last_receipt: r.daysSinceLastReceipt,
  last_bill_date: r.lastBillDate, days_since_last_bill: r.daysSinceLastBill,
  bills: r.bills.map(billView), bills_total: r.billsTotal,
});
