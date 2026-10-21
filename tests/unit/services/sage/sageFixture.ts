/**
 * A synthetic Sage company shaped like a real Sage Business Cloud (SA) pull:
 * negative ids for Sage system accounts, a bank in the account list as
 * AccountType 3, category ids that do NOT match their meaning, and system
 * accounts whose balances live only on the trial balance. Names and amounts
 * are invented.
 */
import type { SagePull } from '@/modules/accounting/services/sage/sageApiTypes';
import type { TakeOnContext } from '@/modules/accounting/services/sage/sageTakeOnTypes';

/** A company's side with no chart: ZAR, a March year, nothing closed. */
export const emptyCompany: TakeOnContext = {
  takenCodes: [], existingRoles: {}, homeCurrency: 'ZAR', fiscalYear: { startDate: '2026-03-01', endDate: '2027-02-28' }, closedPeriods: [],
};

const cat = (ID: number, Description: string) => ({ ID, Description });

export function sageFixture(): SagePull {
  return {
    company: { id: 555, name: 'Acme Media (Pty) Ltd', currencySymbol: 'R' },
    asAtDate: '2026-10-21',
    financialYearStart: '2026-03-01',
    accounts: [
      { ID: -1, Name: 'Sales', Category: cat(1, 'Sales'), Active: true, AccountType: 2, Balance: 0 },
      { ID: -2, Name: 'Purchases', Category: cat(2, 'Cost of Sales'), Active: true, AccountType: 2, Balance: 0 },
      { ID: -7, Name: 'Trade Receivables', Category: cat(6, 'Current Assets'), Active: true, AccountType: 2, Balance: 0 },
      { ID: -8, Name: 'Trade Payables', Category: cat(8, 'Current Liabilities'), Active: true, AccountType: 2, Balance: 0 },
      { ID: -9, Name: 'VAT Payable', Category: cat(8, 'Current Liabilities'), Active: true, AccountType: 2, Balance: 0 },
      { ID: -11, Name: 'Retained Income', Category: cat(9, 'Owners Equity'), Active: true, AccountType: 2, Balance: 0 },
      { ID: -13, Name: 'Opening Balance and VAT Adjustments', Category: cat(9, 'Owners Equity'), Active: true, AccountType: 2, Balance: 0 },
      { ID: 1001, Name: 'Bank - Cheque', Category: cat(6, 'Current Assets'), Active: true, AccountType: 3, Balance: 50000 },
      { ID: 2001, Name: 'Advertising Income', Category: cat(1, 'Sales'), Active: true, AccountType: 1 },
      { ID: 2002, Name: 'Bank Charges', Category: cat(4, 'Expenses'), Active: true, AccountType: 1 },
      { ID: 2003, Name: 'Rent', Category: cat(4, 'Expenses'), Active: true, AccountType: 1 },
      // id 7 is Non-Current Liabilities here; the old id table called 7 equity.
      { ID: 2004, Name: 'Loan - Director', Category: cat(7, 'Non-Current Liabilities'), Active: true, AccountType: 1 },
      { ID: 2005, Name: 'Share Capital', Category: cat(9, 'Owners Equity'), Active: true, AccountType: 1 },
      { ID: 2006, Name: 'Old Unused Account', Category: cat(4, 'Expenses'), Active: false, AccountType: 1 },
    ],
    bankAccounts: [{ ID: 1001, Name: 'Bank - Cheque', Active: true, Balance: 50000 }],
    // Balanced: debits 50000+30000+2000+20000+15000 = 117000; credits 60000+25000+3000+20000+9000 = 117000.
    trialBalance: [
      { AccountId: 1001, Name: 'Bank - Cheque', Debit: 50000, Credit: 0 },
      { AccountId: -7, Name: 'Trade Receivables', Debit: 30000, Credit: 0 },
      { AccountId: 2002, Name: 'Bank Charges', Debit: 2000, Credit: 0 },
      { AccountId: 2003, Name: 'Rent', Debit: 20000, Credit: 0 },
      { AccountId: -11, Name: 'Retained Income', Debit: 15000, Credit: 0 },
      { AccountId: 2001, Name: 'Advertising Income', Debit: 0, Credit: 60000 },
      { AccountId: -8, Name: 'Trade Payables', Debit: 0, Credit: 25000 },
      { AccountId: -9, Name: 'VAT Payable', Debit: 0, Credit: 3000 },
      { AccountId: 2004, Name: 'Loan - Director', Debit: 0, Credit: 20000 },
      { AccountId: 2005, Name: 'Share Capital', Debit: 0, Credit: 9000 },
    ],
    customers: [
      // Two invoices of 12000 + 13000 = 25000 but balance 20000: a 5000 unallocated receipt.
      { ID: 11, Name: 'Bright Billboards', Active: true, Balance: 20000, Email: 'ap@bright.test', Telephone: '011 000 0001', TaxReference: '4000000001' },
      // Balance 10000, no outstanding documents at all: a pure balance brought forward.
      { ID: 12, Name: 'Coastal Radio', Active: true, Balance: 10000 },
      { ID: 13, Name: 'Dormant Client', Active: false, Balance: 0 },
      { ID: 14, Name: 'Active Zero Client', Active: true, Balance: 0 },
    ],
    suppliers: [
      { ID: 21, Name: 'Print House', Active: true, Balance: 27000 },
      // A debit balance on a supplier (we overpaid): cannot be taken on as a bill.
      { ID: 22, Name: 'Overpaid Media', Active: true, Balance: -2000 },
      { ID: 23, Name: 'Print House', Active: true, Balance: 0 },
    ],
    customerDocuments: {
      11: [
        { ID: 9001, DocumentNumber: 'INV0001', Date: '2026-08-01T00:00:00', DueDate: '2026-08-31T00:00:00', Exclusive: 10434.78, Tax: 1565.22, Total: 12000, AmountDue: 12000 },
        { ID: 9002, DocumentNumber: 'INV0002', Date: '2026-09-01T00:00:00', DueDate: '2026-09-30T00:00:00', Exclusive: 11304.35, Tax: 1695.65, Total: 13000, AmountDue: 13000, Reference: 'Sept' },
      ],
      12: [],
    },
    supplierDocuments: {
      21: [
        { ID: 8001, DocumentNumber: 'PH-77', Date: '2026-09-10T00:00:00', DueDate: '2026-10-10T00:00:00', Total: 27000, Tax: 3521.74, AmountDue: 27000 },
      ],
      22: [],
    },
    // Sage's still-owed invoices: what makes an outstanding document an invoice.
    customerInvoices: [{ ID: 9001, DocumentNumber: 'INV0001' }, { ID: 9002, DocumentNumber: 'INV0002' }],
    supplierInvoices: [{ ID: 8001, DocumentNumber: 'PH-77' }],
    currencies: [{ ID: 1, Code: 'ZAR', Symbol: 'R' }, { ID: 4, Code: 'USD', Symbol: '$' }],
  };
}
