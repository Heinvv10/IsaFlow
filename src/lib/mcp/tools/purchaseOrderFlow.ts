/**
 * Flow metering of the purchase-order tools: all free. A purchase order is a commitment: it posts nothing and bills
 * nothing, so loading, editing, cancelling and closing POs, linking bills to them and receiving goods against them (goods received notes) costs no Flows (a pricing decision for the owner; the bulk invoice
 * creates are priced per element because invoices are what the Flows meter counts).
 */
export const PURCHASE_ORDER_FLOW_OPERATIONS: Record<string, null> = {
  list_purchase_orders: null,
  get_purchase_order: null,
  po_status_report: null,
  committed_spend: null,
  bulk_create_purchase_orders: null,
  link_bills_to_purchase_order: null,
  unlink_bill_from_purchase_order: null,
  update_purchase_order: null,
  cancel_purchase_order: null,
  close_purchase_order: null,
  set_purchase_order_status: null,
  list_goods_received: null,
  get_goods_received: null,
  create_goods_received: null,
  cancel_goods_received: null,
};
