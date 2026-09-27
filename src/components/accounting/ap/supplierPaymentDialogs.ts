/**
 * The confirmation copy for the supplier payment page's actions
 * (pages/accounting/supplier-payments/[paymentId].tsx), kept here so the page
 * stays under the 300-line cap.
 */
export const SUPPLIER_PAYMENT_DIALOGS = {
  cancel: {
    title: 'Cancel this payment?',
    message: 'Nothing has been posted for this payment yet. Cancelling stops it for good and releases the bills it was going to pay — no journal is created or reversed. To undo a payment that has already been processed, use Void instead.',
    label: 'Cancel payment',
  },
  void: {
    title: 'Void this processed payment?',
    message: 'The payment has been posted. Void reverses its journal (DR Bank / CR Accounts Payable) and reopens the bills it paid.',
    label: 'Void payment',
  },
  // R-127: a bank-first settlement payment's Void undoes the whole settlement.
  voidSettlement: {
    title: 'Undo this bank-first settlement?',
    message: 'This payment is the settlement of a bill out of a bank-first provisional journal. Void reverses the settlement and the bank-first provisional journal, and frees the bank line for allocation. The bill stays open on Accounts Payable.',
    label: 'Void payment',
  },
  unapply: {
    title: 'Unapply this payment?',
    message: 'Takes the payment off every bill it pays and reopens the bills it pays. The payment and its journal stay; its cash becomes an unapplied credit you can apply to the right bill, or void.',
    label: 'Unapply payment',
  },
} as const;

export type SupplierPaymentDialog = keyof typeof SUPPLIER_PAYMENT_DIALOGS;
