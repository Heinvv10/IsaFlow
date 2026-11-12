/**
 * The bill lines "Copy line items from PO" makes. A copied line keeps its link to the PO line, its account and its
 * dimensions: budgets net a PO line's commitment by the bills linked to it (`remainingCommitted.ts`), so a line without
 * the link is counted twice against the budget, once as the bill and once as the open PO (budgets P5 §9).
 */
import type { BillLineItem, GLAccount } from './BillLineItemsTable';

/**
 * The PO statuses a bill line may link to: the server's `COMMITTING_PO_STATUSES`, which `assertBillPoLinks` enforces
 * (that module reads the database, so it cannot be imported here; a test holds the two equal). The PO picker also
 * offers submitted orders: those lines are copied without a link, and a submitted order commits nothing to net.
 */
export const LINKABLE_PO_STATUSES = ['approved', 'partially_received', 'received'] as const;

export interface PoLineItem {
  /** Absent when the order's status cannot be linked to. */
  poItemId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  glAccountId: string;
  accountCode: string;
  accountName: string;
  cc1Id: string;
  cc2Id: string;
  buId: string;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The lines of a `GET /purchase-orders/[id]` response. */
export function poLinesFromOrder(po: { status?: unknown; items?: Array<Record<string, unknown>> }): PoLineItem[] {
  const linkable = (LINKABLE_PO_STATUSES as readonly unknown[]).includes(po.status);
  return (po.items ?? []).map((item) => ({
    ...(linkable ? { poItemId: String(item.id) } : {}),
    description: text(item.description),
    quantity: Number(item.quantity ?? 1),
    unitPrice: Number(item.unit_price ?? 0),
    taxRate: Number(item.tax_rate ?? 15),
    glAccountId: text(item.gl_account_id),
    accountCode: text(item.account_code),
    accountName: text(item.account_name),
    cc1Id: text(item.cc1_id),
    cc2Id: text(item.cc2_id),
    buId: text(item.bu_id),
  }));
}

/**
 * A PO line's dimensions are taken whole, or the supplier's defaults are when it has none: mixing them could pair the
 * line's CC1 with a default CC2 of another CC1, which the server refuses.
 */
export function billLineFromPo(item: PoLineItem, supplierDims: { cc2Id: string; buId: string }, key: string): BillLineItem {
  const named = item.cc1Id !== '' || item.cc2Id !== '' || item.buId !== '';
  return {
    key,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxRate: item.taxRate,
    glAccountId: item.glAccountId,
    ...(item.poItemId ? { poItemId: item.poItemId } : {}),
    ...(named ? { cc1Id: item.cc1Id, cc2Id: item.cc2Id, buId: item.buId } : supplierDims),
  };
}

/** The picker's accounts plus any PO line's account it does not offer (the bill guard may refuse it), or the line would read as the default. */
export function mergePoAccounts(accounts: GLAccount[], items: readonly PoLineItem[]): GLAccount[] {
  const known = new Set(accounts.map((a) => a.id));
  const added: GLAccount[] = [];
  for (const i of items) {
    if (i.glAccountId === '' || known.has(i.glAccountId)) continue;
    known.add(i.glAccountId);
    added.push({ id: i.glAccountId, accountCode: i.accountCode, accountName: i.accountName });
  }
  return added.length > 0 ? [...accounts, ...added] : accounts;
}
