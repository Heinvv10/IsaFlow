/**
 * Sage Auto-Import Service
 *
 * Pulls data from Sage Business Cloud's internal REST APIs via the user's
 * authenticated browser session. The browser acts as a proxy — ISAFlow
 * injects fetch calls into the Sage tab and receives structured JSON.
 *
 * Discovered endpoints (Sage internal, session-cookie auth):
 *   POST /services/Account/GetWithFilter    → Chart of Accounts
 *   POST /services/Customer/GetWithFilter   → Customers
 *   POST /services/Supplier/GetWithFilter   → Suppliers
 *   POST /services/TaxInvoice/GetWithFilter → Customer Invoices (AR)
 *   POST /services/SupplierInvoice/GetWithFilter → Supplier Invoices (AP)
 *   GET  /services/Company/Current          → Company info
 */

// ── Types for Sage API responses ────────────────────────────────────────────

export interface SageAccount {
  ID: number;
  Name: string;
  Category: { ID: number; Description: string; Order: number };
  Active: boolean;
  Balance: number;
  Description: string;
  AccountType: number; // 1 = user-created, 2 = system
  DefaultTaxTypeId?: number;
  DefaultTaxType?: { ID: number; Name: string; Percentage: number };
}

export interface SageCustomer {
  ID: number;
  Name: string;
  TaxReference: string;
  ContactName: string;
  Telephone: string;
  Mobile: string;
  Email: string;
  Active: boolean;
  Balance: number;
  CreditLimit: number;
}

export interface SageSupplier {
  ID: number;
  Name: string;
  TaxReference: string;
  ContactName: string;
  Telephone: string;
  Mobile: string;
  Email: string;
  Active: boolean;
  Balance: number;
  CreditLimit: number;
}

export interface SageTaxInvoice {
  ID: number;
  CustomerId: number;
  Customer: { Name: string };
  DocumentNumber: string;
  Reference: string;
  Date: string;
  DueDate: string;
  Exclusive: number;
  Tax: number;
  Total: number;
  AmountDue: number;
  Status: string;
}

export interface SageSupplierInvoice {
  ID: number;
  SupplierId: number;
  Supplier: { Name: string };
  DocumentNumber: string;
  Reference: string;
  Date: string;
  DueDate: string;
  Exclusive: number;
  Tax: number;
  Total: number;
  AmountDue: number;
  Status: string;
}

export interface SageCompany {
  ID: number;
  Name: string;
  TaxNumber: string;
  RegistrationNumber: string;
  CurrencySymbol: string;
  TakeOnBalanceDate: string;
}

export interface SagePaginatedResponse<T> {
  Results: T[];
  ReturnedResults: number;
  TotalResults: number;
}

// ── Sage fetch script generator ─────────────────────────────────────────────
// These return JavaScript strings that the browser extension injects into the
// Sage tab. The Sage session cookie authenticates automatically.

export function buildSageFetchScript(endpoint: string, take: number): string {
  return `
    (async () => {
      const allResults = [];
      let skip = 0;
      const take = ${take};
      let total = Infinity;
      while (skip < total) {
        const res = await fetch('${endpoint}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=UTF-8' },
          body: JSON.stringify({ FilterId: 0, Search: '', Skip: skip, Take: take }),
          credentials: 'include'
        });
        const json = await res.json();
        total = json.TotalResults || 0;
        allResults.push(...(json.Results || []));
        skip += take;
      }
      return { Results: allResults, TotalResults: total };
    })()
  `.trim();
}

export function buildSageAccountsFetchScript(): string {
  return `
    (async () => {
      const allResults = [];
      let skip = 0;
      const take = 200;
      let total = Infinity;
      while (skip < total) {
        const res = await fetch('/services/Account/GetWithFilter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=UTF-8' },
          body: JSON.stringify({
            FilterId: 2,
            Search: '',
            Skip: skip,
            Take: take,
            OrderBy: 'AccountCategory_Order asc, Account_Type DESC, Account_Name Asc'
          }),
          credentials: 'include'
        });
        const json = await res.json();
        total = json.TotalResults || 0;
        allResults.push(...(json.Results || []));
        skip += take;
      }
      return { Results: allResults, TotalResults: total };
    })()
  `.trim();
}

export function buildSageCompanyFetchScript(): string {
  return `
    (async () => {
      const res = await fetch('/services/Company/Current', { credentials: 'include' });
      return await res.json();
    })()
  `.trim();
}

// ── Mappers: Sage → ISAFlow ─────────────────────────────────────────────────

const SAGE_CATEGORY_TO_TYPE: Record<number, string> = {
  1: 'revenue',     // Sales
  2: 'expense',     // Cost of Sales
  3: 'revenue',     // Other Income
  4: 'expense',     // Expenses
  5: 'asset',       // Fixed Assets
  6: 'asset',       // Current Assets
  7: 'equity',      // Equity
  8: 'liability',   // Current Liabilities
  9: 'liability',   // Long Term Liabilities
};

const SAGE_CATEGORY_TO_NORMAL: Record<number, string> = {
  1: 'credit',  // Sales
  2: 'debit',   // Cost of Sales
  3: 'credit',  // Other Income
  4: 'debit',   // Expenses
  5: 'debit',   // Fixed Assets
  6: 'debit',   // Current Assets
  7: 'credit',  // Equity
  8: 'credit',  // Current Liabilities
  9: 'credit',  // Long Term Liabilities
};

export function mapSageAccounts(accounts: SageAccount[]) {
  return accounts.map((a, i) => ({
    accountCode: String(a.ID > 0 ? a.ID : `SYS-${Math.abs(a.ID)}`),
    accountName: a.Name,
    accountType: SAGE_CATEGORY_TO_TYPE[a.Category?.ID] || 'expense',
    normalBalance: SAGE_CATEGORY_TO_NORMAL[a.Category?.ID] || 'debit',
    description: a.Description || '',
    categoryName: a.Category?.Description || '',
    categoryOrder: a.Category?.Order ?? i,
    isSystem: a.AccountType === 2,
    isActive: a.Active,
    balance: a.Balance,
    sageId: a.ID,
  }));
}

export function mapSageCustomers(customers: SageCustomer[]) {
  return customers.map(c => ({
    name: c.Name,
    email: c.Email || '',
    phone: c.Telephone || c.Mobile || '',
    vatNumber: c.TaxReference || '',
    contactPerson: c.ContactName || '',
    creditLimit: c.CreditLimit || 0,
    balance: c.Balance,
    sageId: c.ID,
  }));
}

export function mapSageSuppliers(suppliers: SageSupplier[]) {
  return suppliers.map(s => ({
    name: s.Name,
    email: s.Email || '',
    phone: s.Telephone || s.Mobile || '',
    vatNumber: s.TaxReference || '',
    contactPerson: s.ContactName || '',
    creditLimit: s.CreditLimit || 0,
    balance: s.Balance,
    sageId: s.ID,
  }));
}

export function mapSageARInvoices(invoices: SageTaxInvoice[]) {
  return invoices.map(inv => ({
    invoiceNumber: inv.DocumentNumber,
    customerName: inv.Customer?.Name || '',
    invoiceDate: inv.Date?.split('T')[0] || '',
    dueDate: inv.DueDate?.split('T')[0] || '',
    subtotal: inv.Exclusive,
    taxAmount: inv.Tax,
    totalAmount: inv.Total,
    amountPaid: inv.Total - inv.AmountDue,
    reference: inv.Reference || '',
    sageId: inv.ID,
  }));
}

export function mapSageAPInvoices(invoices: SageSupplierInvoice[]) {
  return invoices.map(inv => ({
    invoiceNumber: inv.DocumentNumber,
    supplierName: inv.Supplier?.Name || '',
    invoiceDate: inv.Date?.split('T')[0] || '',
    dueDate: inv.DueDate?.split('T')[0] || '',
    subtotal: inv.Exclusive,
    taxAmount: inv.Tax,
    totalAmount: inv.Total,
    amountPaid: inv.Total - inv.AmountDue,
    reference: inv.Reference || '',
    sageId: inv.ID,
  }));
}
