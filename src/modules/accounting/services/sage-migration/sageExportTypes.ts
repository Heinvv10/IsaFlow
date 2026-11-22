/**
 * Sage Business Cloud Accounting (South Africa, API v2 "Sage One") export: the shapes this migration reads and the rows it
 * produces. The assumed JSON shape of the export is documented in docs/design/sage-migration-export-format.md; every field
 * named here is one the parsers read. A field the export carries that is not named here is ignored, and
 * `QuantityOnHand` is ignored on purpose (it is never imported as opening stock, see sageItemParser).
 */

export type SageEntity = 'category' | 'item' | 'purchase_order';

/** A row the migration will not send, with the reasons (all of them, so one pass fixes the file). */
export interface RowRefusal {
  entity: SageEntity;
  /** The Sage ID when the row has a usable one. */
  sageId: string | null;
  /** What a person recognises the row by: the item code or the PO document number. */
  label: string;
  code: string;
  reasons: string[];
}

export interface SageCategory {
  id: string;
  description: string;
}

export interface SageItem {
  id: string;
  code: string;
  description: string;
  active: boolean;
  /** false = a Sage service code. */
  physical: boolean;
  priceExclusive: number | null;
  lastCost: number | null;
  averageCost: number | null;
  taxSales: SageTaxType | null;
  taxPurchases: SageTaxType | null;
  category: SageCategory | null;
  /** The export carried a QuantityOnHand. Counted for the report, never used. */
  hadQuantityOnHand: boolean;
}

export type SageTaxType = 'standard' | 'zero' | 'exempt';

export interface SagePoLine {
  description: string;
  quantity: number;
  unitPriceExclusive: number;
  /** VAT percentage of the line. */
  taxRate: number;
  exclusive: number | null;
  tax: number | null;
  /** The Sage item ID the line names, when it names one. */
  itemId: string | null;
}

export interface SagePurchaseOrder {
  id: string;
  documentNumber: string;
  /** YYYY-MM-DD */
  date: string;
  deliveryDate: string | null;
  /** The Sage status as exported (Pending, Overdue, Invoiced, Cancelled). */
  status: string;
  reference: string | null;
  comments: string | null;
  supplierId: string;
  supplierName: string | null;
  exclusive: number;
  tax: number;
  total: number;
  lines: SagePoLine[];
  /** File name of the PO's PDF in the export bundle, when the export names one. */
  pdfFile: string | null;
}

/** Result of reading one row: the typed row, or why it is refused. */
export type RowResult<T> = { ok: true; value: T } | { ok: false; refusal: RowRefusal };

export interface ParsedExport {
  categories: SageCategory[];
  items: SageItem[];
  purchaseOrders: SagePurchaseOrder[];
  refusals: RowRefusal[];
  /** Sage item ID -> item Code, for every item row with a usable ID and Code (a PO line names its item by it). */
  itemCodes: Record<string, string>;
  /** Rows read per entity, accepted or refused. */
  rowsIn: { items: number; purchaseOrders: number };
  /** Sum of the header Total of EVERY PO row that has a readable one, accepted or refused, in cents. */
  exportPoTotalCents: number;
  /** Items whose export row carried a QuantityOnHand (all ignored). */
  itemsWithQuantityOnHand: number;
}
