/**
 * Flow metering of the purchase-order tools: all free. A purchase order is a commitment: it posts nothing and bills
 * nothing, so loading POs and linking bills to them costs no Flows (a pricing decision for the owner; the bulk invoice
 * creates are priced per element because invoices are what the Flows meter counts).
 */
export const PURCHASE_ORDER_FLOW_OPERATIONS: Record<string, null> = {
  list_purchase_orders: null,
  get_purchase_order: null,
  bulk_create_purchase_orders: null,
  link_bills_to_purchase_order: null,
  unlink_bill_from_purchase_order: null,
};
