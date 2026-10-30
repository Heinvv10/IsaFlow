// The converted document-date forms of wave 2 PR A: how to render each and which DateFields it carries.
import { fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import DocCapture from '../../../pages/accounting/document-capture/[docId]';
import ExpenseDetail from '../../../pages/accounting/expenses/[id]';
import PoDetail from '../../../pages/accounting/purchase-orders/[poId]';
import RecurringInvoiceEdit from '../../../pages/accounting/recurring-invoices/[id]';
import BankRecNew from '../../../pages/accounting/bank-reconciliation/new';
import BankTxNew from '../../../pages/accounting/bank-transactions/new';
import BankTransfers from '../../../pages/accounting/bank-transfers/index';
import CreditNoteNew from '../../../pages/accounting/credit-notes/new';
import CustomerPaymentNew from '../../../pages/accounting/customer-payments/new';
import QuotesIndex from '../../../pages/accounting/customer-quotes/index';
import SalesOrdersIndex from '../../../pages/accounting/customer-sales-orders/index';
import DeliveryNoteNew from '../../../pages/accounting/delivery-notes/new';
import ExpenseNew from '../../../pages/accounting/expenses/new';
import GoodsReceivedNew from '../../../pages/accounting/goods-received/new';
import ItemAdjustments from '../../../pages/accounting/item-adjustments';
import JournalEntryNew from '../../../pages/accounting/journal-entries/new';
import PoNew from '../../../pages/accounting/purchase-orders/new';
import RecurringInvoiceNew from '../../../pages/accounting/recurring-invoices/new';
import RecurringJournals from '../../../pages/accounting/recurring-journals/index';
import SupplierCreditNoteNew from '../../../pages/accounting/supplier-credit-notes/new';
import SupplierInvoiceNew from '../../../pages/accounting/supplier-invoices/new';
import SupplierPaymentNew from '../../../pages/accounting/supplier-payments/new';
import VatAdjustments from '../../../pages/accounting/vat-adjustments/index';

export interface DateCase {
  page: string;
  element: ReactNode;
  /** Route query for the page (detail pages read their id from it). */
  query?: Record<string, string>;
  /** `data` for a GET url, when the page needs a loaded record; anything else gets []. */
  respond?: (url: string) => unknown;
  open?: () => Promise<void> | void;
  fields: { label: string; name: string }[];
  /** The page clears a refused date (its date is required, so its own validation refuses the save) instead of keeping the old one. */
  clearsRefused?: boolean;
}

const click = async (name: RegExp): Promise<void> => { fireEvent.click(await screen.findByRole('button', { name })); };

export const cases: DateCase[] = [
  { page: 'bank-reconciliation/new', element: <BankRecNew />, fields: [{ label: 'Statement Date', name: 'statementDate' }] },
  { page: 'bank-transactions/new', element: <BankTxNew />, clearsRefused: true, fields: [{ label: 'Date', name: 'date' }] },
  { page: 'bank-transfers', element: <BankTransfers />, fields: [{ label: 'Date', name: 'transferDate' }] },
  { page: 'credit-notes/new', element: <CreditNoteNew />, fields: [{ label: 'Credit Date', name: 'creditDate' }] },
  { page: 'customer-payments/new', element: <CustomerPaymentNew />, fields: [{ label: 'Payment Date', name: 'paymentDate' }] },
  { page: 'customer-quotes (new quote)', element: <QuotesIndex />, open: () => click(/new quote/i),
    fields: [{ label: 'Quote Date', name: 'quoteDate' }, { label: 'Expiry Date', name: 'expiryDate' }] },
  { page: 'customer-sales-orders (new order)', element: <SalesOrdersIndex />, open: () => click(/new (sales )?order/i),
    fields: [{ label: 'Order Date', name: 'orderDate' }, { label: 'Delivery Date', name: 'deliveryDate' }] },
  { page: 'delivery-notes/new', element: <DeliveryNoteNew />, fields: [{ label: 'Delivery Date', name: 'deliveryDate' }] },
  { page: 'expenses/new', element: <ExpenseNew />, fields: [{ label: 'Claim date', name: 'claimDate' }] },
  { page: 'goods-received/new', element: <GoodsReceivedNew />, fields: [{ label: 'Receipt Date', name: 'receivedDate' }] },
  { page: 'item-adjustments', element: <ItemAdjustments />, open: () => click(/new adjustment|adjust/i), fields: [{ label: 'Date', name: 'adjustmentDate' }] },
  { page: 'journal-entries/new', element: <JournalEntryNew />, fields: [{ label: 'Entry Date', name: 'entryDate' }] },
  { page: 'purchase-orders/new', element: <PoNew />,
    fields: [{ label: 'Order Date', name: 'orderDate' }, { label: 'Expected Delivery', name: 'expectedDeliveryDate' }] },
  { page: 'recurring-invoices/new', element: <RecurringInvoiceNew />,
    fields: [{ label: 'First Run Date', name: 'nextRunDate' }, { label: 'End Date', name: 'endDate' }] },
  { page: 'recurring-journals', element: <RecurringJournals />, open: () => click(/new/i), fields: [{ label: 'First Run Date', name: 'nextRunDate' }] },
  { page: 'supplier-credit-notes/new', element: <SupplierCreditNoteNew />, fields: [{ label: 'Credit Note Date', name: 'creditDate' }] },
  { page: 'supplier-invoices/new', element: <SupplierInvoiceNew />,
    fields: [{ label: 'Invoice Date', name: 'invoiceDate' }, { label: 'Due Date', name: 'dueDate' }] },
  { page: 'supplier-payments/new', element: <SupplierPaymentNew />, fields: [{ label: 'Payment Date', name: 'paymentDate' }] },
  { page: 'vat-adjustments', element: <VatAdjustments />, open: () => click(/new/i), fields: [{ label: 'Adjustment Date', name: 'adjustmentDate' }] },
  { page: 'expenses/[id] (receipt and mileage lines)', element: <ExpenseDetail />, query: { id: 'claim-1' },
    respond: (u) => (u.includes('expense-claims/claim-1') ? { claim: { id: 'claim-1', claimNumber: 'EC-1', claimDate: '2026-10-01', employeeId: 'e1', title: null, description: null,
      status: 'draft', totalAmount: 0, totalVat: 0, approvedBy: null, approvedAt: null, rejectionReason: null, postedJeId: null, postedAt: null, lines: [], mileage: [] } } : undefined),
    open: async () => { await click(/add receipt/i); },
    clearsRefused: true,
    fields: [{ label: 'Date', name: 'lineDate' }] },
  { page: 'purchase-orders/[poId] (edit)', element: <PoDetail />, query: { poId: 'po-1' },
    respond: (u) => (u.endsWith('purchase-orders/po-1') ? { id: 'po-1', po_number: 'PO-1', status: 'draft', supplier_id: 's1', order_date: '2026-10-01', expected_delivery_date: null, items: [] } : undefined),
    open: async () => { await click(/^edit$/i); },
    fields: [{ label: 'Order Date', name: 'orderDate' }, { label: 'Expected Delivery', name: 'expectedDeliveryDate' }] },
  { page: 'recurring-invoices/[id]', element: <RecurringInvoiceEdit />, query: { id: 'ri-1' },
    respond: (u) => (u.endsWith('recurring-invoices') ? { items: [{ id: 'ri-1', templateName: 'T', clientId: 'c1', frequency: 'monthly', nextRunDate: '2026-11-01', lineItems: [] }] } : undefined),
    fields: [{ label: 'Next Run Date', name: 'nextRunDate' }, { label: 'End Date', name: 'endDate' }] },
  { page: 'document-capture/[docId]', element: <DocCapture />, query: { docId: 'doc-1' },
    respond: (u) => (u.includes('document-capture?id=doc-1') ? { id: 'doc-1', status: 'pending', readState: 'done', documentDate: '2026-10-01', extractedData: null, vendorName: 'V' } : undefined),
    fields: [{ label: 'Date', name: 'documentDate' }] },
];
