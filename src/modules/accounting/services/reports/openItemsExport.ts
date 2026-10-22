/**
 * `ap_open_items` / `ar_open_items` — the aged creditors / aged debtors
 * population, ONE ROW PER DOCUMENT, for a dashboard that needs the documents
 * behind the aged totals.
 *
 * Rows:
 *  - `invoice` — every open posted bill / invoice, from the SAME query the
 *    aging runs (ap/apAgingInvoices, ar/arAgingInvoices), so the same status
 *    population, ledger presence and point-in-time rewind. Outstanding is the
 *    balance less any open dispute (AR), which is what the buckets carry;
 *    Disputed states the rest.
 *  - `credit_note` and `unapplied_payment` / `unapplied_receipt` — NEGATIVE
 *    rows: the unconsumed credit and on-account cash the aged report nets off
 *    each entity, from shared/unappliedDocuments (the rows
 *    agedNetting.getUnappliedByEntity sums). A refund carries its own sign.
 *
 * THE CONTROL: Σ Outstanding equals the aged report's net `total` to the cent.
 * The summary proves it on every call rather than asserting it: `agedTotal`
 * is computed through the aged tools' own functions (calculateAgingBuckets →
 * netAgingRows over aggregateUnappliedByEntity) from the same fetched data,
 * and `difference` is controlTotal − agedTotal. The one population rule taken
 * from the report: an entity with no open invoice whose on-account entries
 * net to R0.01 or less has no row in the report, so its documents have none
 * here either.
 *
 * Age: as at today on this server's calendar (fmtDate, local SAST — the aged
 * tools' default). Invoice rows age from Due_Date (the due date, else the
 * invoice date, exactly as the aging does) through utils/aging's
 * getAgingBucket, so their buckets sum to the report's gross buckets. Credit
 * and cash rows have no due date; they age from their own date, for
 * information only — the report does not bucket them.
 */

import { fmtDate } from '@/lib/fmtDate';
import { calculateAgingBuckets, daysOverdue, getAgingBucket } from '@/modules/accounting/utils/aging';
import type { AgingBucketName } from '@/modules/accounting/types/ap.types';
import { fetchAPAgingInvoices, type OpenAgingInvoice } from '@/modules/accounting/services/ap/apAgingInvoices';
import { fetchARAgingInvoices } from '@/modules/accounting/services/ar/arAgingInvoices';
import { getUnappliedDocuments, type UnappliedDocument } from '@/modules/accounting/services/shared/unappliedDocuments';
import { aggregateUnappliedByEntity, netAgingRows } from '@/modules/accounting/services/shared/agedNetting';
import { creditNoteDimensions, documentsOnFile, invoiceDimensions, type DocDimensions } from './openItemsLookups';
import type { ExportValue } from './glLineExportRows';

export const OPEN_ITEMS_SCHEMA_VERSION = 'isaflow-open-items-1.0';
export type OpenItemsSide = 'ap' | 'ar';
export type OpenItemsRow = Record<string, ExportValue>;

const COMMON_HEAD = ['Doc_ID', 'Doc_Type', 'Doc_No'] as const;
const COMMON_TAIL = ['Counterparty_ID', 'Counterparty_Name', 'Doc_Date', 'Due_Date', 'Days_Overdue',
  'Age_Bucket', 'Total_Incl_VAT', 'Outstanding', 'Disputed', 'CC1_Code', 'CC2_Code', 'BU_Code',
  'Has_Document', 'Schema_Version'] as const;

export const OPEN_ITEMS_COLUMNS: Record<OpenItemsSide, readonly string[]> = {
  ap: [...COMMON_HEAD, 'Supplier_Ref', ...COMMON_TAIL],
  ar: [...COMMON_HEAD, 'Customer_Ref', ...COMMON_TAIL],
};

const BUCKET_LABEL: Record<AgingBucketName, string> = {
  current: 'current', days30: '30', days60: '60', days90: '90', days120Plus: '120+',
};

export interface OpenItemsSummary {
  table: 'ap_open_items' | 'ar_open_items';
  schemaVersion: string;
  asAt: string;
  rowCount: number;
  invoiceCount: number;
  /** Σ Outstanding over invoice rows — the aged report's gross_total. */
  grossTotal: number;
  /** Σ Outstanding over credit-note and unapplied-cash rows (negative). */
  unappliedTotal: number;
  /** Σ Outstanding over every row. */
  controlTotal: number;
  /** The aged report's net total, computed through its own functions. */
  agedTotal: number;
  agedGrossTotal: number;
  /** controlTotal − agedTotal. 0.00 is the control holding. */
  difference: number;
  /** Invoice rows' Outstanding per Age_Bucket — the report's gross buckets. */
  buckets: Record<string, number>;
}

export interface OpenItemsResult {
  columns: readonly string[];
  rows: OpenItemsRow[];
  summary: OpenItemsSummary;
}

/** Whole cents, so a sum of thousands of rows carries no float residue. */
const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): number => c / 100 || 0;

function age(date: string, asAt: Date): { days: number | null; bucket: string } {
  const d = new Date(date);
  const days = daysOverdue(d, asAt);
  return { days: Number.isNaN(days) ? null : days, bucket: BUCKET_LABEL[getAgingBucket(d, asAt)] };
}

function dims(row: OpenItemsRow, d: DocDimensions | undefined): void {
  row.CC1_Code = d?.cc1 ?? null;
  row.CC2_Code = d?.cc2 ?? null;
  row.BU_Code = d?.bu ?? null;
}

function invoiceRow(side: OpenItemsSide, inv: OpenAgingInvoice, asAt: Date): OpenItemsRow {
  const disputed = Math.min(Math.max(inv.disputedAmount ?? 0, 0), inv.balance);
  const { days, bucket } = age(inv.dueDate, asAt);
  return {
    Doc_ID: inv.id, Doc_Type: 'invoice', Doc_No: inv.invoiceNumber,
    [side === 'ap' ? 'Supplier_Ref' : 'Customer_Ref']: inv.reference,
    Counterparty_ID: inv.entityId, Counterparty_Name: inv.entityName,
    Doc_Date: inv.invoiceDate, Due_Date: fmtDate(inv.dueDate), Days_Overdue: days, Age_Bucket: bucket,
    Total_Incl_VAT: money(cents(inv.totalAmount)),
    Outstanding: money(cents(inv.balance) - cents(disputed)),
    Disputed: money(cents(disputed)),
    Schema_Version: OPEN_ITEMS_SCHEMA_VERSION,
  };
}

function creditRow(side: OpenItemsSide, doc: UnappliedDocument, asAt: Date): OpenItemsRow {
  const { days, bucket } = age(doc.date, asAt);
  const cashType = side === 'ap' ? 'unapplied_payment' : 'unapplied_receipt';
  return {
    Doc_ID: doc.id, Doc_Type: doc.kind === 'credit_note' ? 'credit_note' : cashType, Doc_No: doc.number,
    [side === 'ap' ? 'Supplier_Ref' : 'Customer_Ref']: doc.reference,
    Counterparty_ID: doc.entityId, Counterparty_Name: doc.entityName,
    Doc_Date: doc.date, Due_Date: null, Days_Overdue: days, Age_Bucket: bucket,
    Total_Incl_VAT: money(-cents(doc.totalAmount)),
    Outstanding: money(-cents(doc.amount)),
    Disputed: 0,
    Schema_Version: OPEN_ITEMS_SCHEMA_VERSION,
  };
}

/** The total order rows are listed and paged in: (Doc_Type, Doc_ID). */
export function openItemKey(row: OpenItemsRow): readonly [string, string] {
  return [String(row.Doc_Type), String(row.Doc_ID)];
}

const byKey = (a: OpenItemsRow, b: OpenItemsRow): number => {
  const [ka, ia] = openItemKey(a);
  const [kb, ib] = openItemKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : ia < ib ? -1 : ia > ib ? 1 : 0;
};

/**
 * Every open item of one side as at `asAtStr` (default today), sorted by
 * (Doc_Type, Doc_ID), with the control summary. Reads run SEQUENTIALLY: one pg
 * client per request transaction.
 */
export async function buildOpenItems(
  companyId: string,
  side: OpenItemsSide,
  asAtStr: string = fmtDate(new Date()),
): Promise<OpenItemsResult> {
  const todayStr = fmtDate(new Date());
  const asAt = new Date(asAtStr);
  const invoices = side === 'ap'
    ? await fetchAPAgingInvoices(companyId, asAtStr, todayStr)
    : await fetchARAgingInvoices(companyId, asAtStr, todayStr);
  const allDocs = await getUnappliedDocuments(companyId, side, asAtStr);

  // The aged report's own arithmetic over the same data.
  const netted = netAgingRows(calculateAgingBuckets(invoices, asAt), aggregateUnappliedByEntity(allDocs));
  const inReport = new Set(netted.map((r) => r.entityId));
  const docs = allDocs.filter((d) => inReport.has(d.entityId));

  const invIds = invoices.map((i) => i.id);
  const cnIds = docs.filter((d) => d.kind === 'credit_note').map((d) => d.id);
  const cashIds = docs.filter((d) => d.kind === 'payment').map((d) => d.id);
  const invDims = await invoiceDimensions(companyId, side, invIds);
  const cnDims = await creditNoteDimensions(companyId, cnIds);
  const onFile = await documentsOnFile(companyId, [
    [side === 'ap' ? 'supplier_invoice' : 'customer_invoice', invIds],
    ['credit_note', cnIds],
    [side === 'ap' ? 'supplier_payment' : 'customer_payment', cashIds],
  ]);

  const rows: OpenItemsRow[] = [];
  const bucketCents: Record<string, number> = { current: 0, '30': 0, '60': 0, '90': 0, '120+': 0 };
  let grossCents = 0;
  for (const inv of invoices) {
    const row = invoiceRow(side, inv, asAt);
    dims(row, invDims.get(inv.id));
    row.Has_Document = onFile.has(inv.id);
    grossCents += cents(row.Outstanding as number);
    const bucket = String(row.Age_Bucket);
    bucketCents[bucket] = (bucketCents[bucket] ?? 0) + cents(row.Outstanding as number);
    rows.push(row);
  }
  let unappliedCents = 0;
  for (const doc of docs) {
    const row = creditRow(side, doc, asAt);
    dims(row, doc.kind === 'credit_note' ? cnDims.get(doc.id) : undefined);
    row.Has_Document = onFile.has(doc.id);
    unappliedCents += cents(row.Outstanding as number);
    rows.push(row);
  }
  rows.sort(byKey);

  const agedTotal = money(netted.reduce((s, r) => s + cents(r.net), 0));
  const controlTotal = money(grossCents + unappliedCents);
  return {
    columns: OPEN_ITEMS_COLUMNS[side],
    rows,
    summary: {
      table: side === 'ap' ? 'ap_open_items' : 'ar_open_items',
      schemaVersion: OPEN_ITEMS_SCHEMA_VERSION,
      asAt: asAtStr,
      rowCount: rows.length,
      invoiceCount: invoices.length,
      grossTotal: money(grossCents),
      unappliedTotal: money(unappliedCents),
      controlTotal,
      agedTotal,
      agedGrossTotal: money(netted.reduce((s, r) => s + cents(r.total), 0)),
      difference: money(cents(controlTotal) - cents(agedTotal)),
      buckets: Object.fromEntries(Object.entries(bucketCents).map(([k, v]) => [k, money(v)])),
    },
  };
}
