// RED phase — written before implementation
/**
 * Unit tests for csvFieldMapper.ts
 * Tests auto-mapping of CSV headers to ISAFlow field names per source system.
 */

import { describe, it, expect } from 'vitest';
import { autoMapFields } from '@/modules/accounting/utils/csvFieldMapper';

// ── Sage Cloud — 3-digit account codes ──────────────────────────────────────

describe('autoMapFields — Sage Cloud chart-of-accounts', () => {
  it('maps AccountNumber to account_code', () => {
    const result = autoMapFields(['AccountNumber'], 'sage_cloud', 'chart-of-accounts');
    expect(result['AccountNumber']).toBe('account_code');
  });

  it('maps LedgerCode to account_code (Sage Cloud specific)', () => {
    const result = autoMapFields(['LedgerCode'], 'sage_cloud', 'chart-of-accounts');
    expect(result['LedgerCode']).toBe('account_code');
  });

  it('maps AccountName to account_name', () => {
    const result = autoMapFields(['AccountName'], 'sage_cloud', 'chart-of-accounts');
    expect(result['AccountName']).toBe('account_name');
  });

  it('maps Type to account_type', () => {
    const result = autoMapFields(['Type'], 'sage_cloud', 'chart-of-accounts');
    expect(result['Type']).toBe('account_type');
  });

  it('maps NormalBalance to normal_balance', () => {
    const result = autoMapFields(['NormalBalance'], 'sage_cloud', 'chart-of-accounts');
    expect(result['NormalBalance']).toBe('normal_balance');
  });

  it('maps ParentCode to parent_code', () => {
    const result = autoMapFields(['ParentCode'], 'sage_cloud', 'chart-of-accounts');
    expect(result['ParentCode']).toBe('parent_code');
  });

  it('maps all known Sage Cloud headers in one call', () => {
    const headers = ['AccountNumber', 'AccountName', 'Type', 'NormalBalance', 'ParentCode'];
    const result = autoMapFields(headers, 'sage_cloud', 'chart-of-accounts');
    expect(result['AccountNumber']).toBe('account_code');
    expect(result['AccountName']).toBe('account_name');
    expect(result['Type']).toBe('account_type');
    expect(result['NormalBalance']).toBe('normal_balance');
    expect(result['ParentCode']).toBe('parent_code');
  });

  it('returns unrecognized headers as-is (identity mapping)', () => {
    const result = autoMapFields(['CustomColumn'], 'sage_cloud', 'chart-of-accounts');
    expect(result['CustomColumn']).toBe('CustomColumn');
  });
});

// ── Sage 50 / Pastel — 7-digit account codes ─────────────────────────────────

describe('autoMapFields — Sage 50 chart-of-accounts', () => {
  it('maps NominalCode to account_code (Sage 50 specific)', () => {
    const result = autoMapFields(['NominalCode'], 'sage_50', 'chart-of-accounts');
    expect(result['NominalCode']).toBe('account_code');
  });

  it('maps MasterAccount to account_code (Sage 50 specific)', () => {
    const result = autoMapFields(['MasterAccount'], 'sage_50', 'chart-of-accounts');
    expect(result['MasterAccount']).toBe('account_code');
  });

  it('maps GroupHeader to parent_code (Sage 50 hierarchy)', () => {
    const result = autoMapFields(['GroupHeader'], 'sage_50', 'chart-of-accounts');
    expect(result['GroupHeader']).toBe('parent_code');
  });

  it('Pastel uses same COA aliases as Sage 50', () => {
    const sage50Result = autoMapFields(['NominalCode', 'GroupHeader'], 'sage_50', 'chart-of-accounts');
    const pastelResult = autoMapFields(['NominalCode', 'GroupHeader'], 'pastel', 'chart-of-accounts');
    expect(sage50Result).toEqual(pastelResult);
  });
});

// ── Xero ─────────────────────────────────────────────────────────────────────

describe('autoMapFields — Xero chart-of-accounts', () => {
  it('maps Code to account_code', () => {
    const result = autoMapFields(['Code'], 'xero', 'chart-of-accounts');
    expect(result['Code']).toBe('account_code');
  });

  it('maps TaxType to account_subtype (Xero specific)', () => {
    const result = autoMapFields(['TaxType'], 'xero', 'chart-of-accounts');
    expect(result['TaxType']).toBe('account_subtype');
  });
});

// ── QuickBooks ────────────────────────────────────────────────────────────────

describe('autoMapFields — QuickBooks chart-of-accounts', () => {
  it('maps AcctNumber to account_code', () => {
    const result = autoMapFields(['AcctNumber'], 'quickbooks', 'chart-of-accounts');
    expect(result['AcctNumber']).toBe('account_code');
  });

  it('maps AcctType to account_type', () => {
    const result = autoMapFields(['AcctType'], 'quickbooks', 'chart-of-accounts');
    expect(result['AcctType']).toBe('account_type');
  });
});

// ── Customers step ────────────────────────────────────────────────────────────

describe('autoMapFields — customers step', () => {
  it('maps CustomerName to name', () => {
    const result = autoMapFields(['CustomerName'], 'sage_cloud', 'customers');
    expect(result['CustomerName']).toBe('name');
  });

  it('maps EmailAddress to email', () => {
    const result = autoMapFields(['EmailAddress'], 'sage_cloud', 'customers');
    expect(result['EmailAddress']).toBe('email');
  });

  it('maps Telephone to phone', () => {
    const result = autoMapFields(['Telephone'], 'sage_cloud', 'customers');
    expect(result['Telephone']).toBe('phone');
  });

  it('maps VATNumber to vat_number', () => {
    const result = autoMapFields(['VATNumber'], 'sage_cloud', 'customers');
    expect(result['VATNumber']).toBe('vat_number');
  });

  it('maps CreditLimit to credit_limit', () => {
    const result = autoMapFields(['CreditLimit'], 'sage_cloud', 'customers');
    expect(result['CreditLimit']).toBe('credit_limit');
  });

  it('maps PaymentTerms to payment_terms', () => {
    const result = autoMapFields(['PaymentTerms'], 'sage_cloud', 'customers');
    expect(result['PaymentTerms']).toBe('payment_terms');
  });
});

// ── Suppliers step ────────────────────────────────────────────────────────────

describe('autoMapFields — suppliers step', () => {
  it('maps SupplierName to name', () => {
    const result = autoMapFields(['SupplierName'], 'sage_cloud', 'suppliers');
    expect(result['SupplierName']).toBe('name');
  });

  it('maps BankAccount to bank_account_number', () => {
    const result = autoMapFields(['BankAccount'], 'sage_cloud', 'suppliers');
    expect(result['BankAccount']).toBe('bank_account_number');
  });

  it('maps BranchCode to bank_branch_code', () => {
    const result = autoMapFields(['BranchCode'], 'sage_cloud', 'suppliers');
    expect(result['BranchCode']).toBe('bank_branch_code');
  });
});

// ── Opening balances step ─────────────────────────────────────────────────────

describe('autoMapFields — opening-balances step', () => {
  it('maps Debit to debit_balance', () => {
    const result = autoMapFields(['Debit'], 'sage_cloud', 'opening-balances');
    expect(result['Debit']).toBe('debit_balance');
  });

  it('maps Credit to credit_balance', () => {
    const result = autoMapFields(['Credit'], 'sage_cloud', 'opening-balances');
    expect(result['Credit']).toBe('credit_balance');
  });

  it('maps Dr shorthand to debit_balance', () => {
    const result = autoMapFields(['Dr'], 'sage_50', 'opening-balances');
    expect(result['Dr']).toBe('debit_balance');
  });

  it('maps Cr shorthand to credit_balance', () => {
    const result = autoMapFields(['Cr'], 'sage_50', 'opening-balances');
    expect(result['Cr']).toBe('credit_balance');
  });
});

// ── AR Invoices step ──────────────────────────────────────────────────────────

describe('autoMapFields — ar-invoices step', () => {
  it('maps InvoiceNumber to invoice_number', () => {
    const result = autoMapFields(['InvoiceNumber'], 'sage_cloud', 'ar-invoices');
    expect(result['InvoiceNumber']).toBe('invoice_number');
  });

  it('maps CustomerName to customer_name', () => {
    const result = autoMapFields(['CustomerName'], 'sage_cloud', 'ar-invoices');
    expect(result['CustomerName']).toBe('customer_name');
  });

  it('maps VATAmount to tax_amount', () => {
    const result = autoMapFields(['VATAmount'], 'sage_cloud', 'ar-invoices');
    expect(result['VATAmount']).toBe('tax_amount');
  });

  it('maps TotalAmount to total_amount', () => {
    const result = autoMapFields(['TotalAmount'], 'sage_cloud', 'ar-invoices');
    expect(result['TotalAmount']).toBe('total_amount');
  });

  it('maps AmountPaid to amount_paid', () => {
    const result = autoMapFields(['AmountPaid'], 'sage_cloud', 'ar-invoices');
    expect(result['AmountPaid']).toBe('amount_paid');
  });
});

// ── AP Invoices step ──────────────────────────────────────────────────────────

describe('autoMapFields — ap-invoices step', () => {
  it('maps SupplierName to supplier_name', () => {
    const result = autoMapFields(['SupplierName'], 'sage_cloud', 'ap-invoices');
    expect(result['SupplierName']).toBe('supplier_name');
  });

  it('maps VendorName to supplier_name', () => {
    const result = autoMapFields(['VendorName'], 'sage_cloud', 'ap-invoices');
    expect(result['VendorName']).toBe('supplier_name');
  });
});

// ── Case/whitespace normalization ─────────────────────────────────────────────

describe('autoMapFields — header normalization', () => {
  it('normalizes uppercase headers', () => {
    const result = autoMapFields(['ACCOUNTNAME'], 'sage_cloud', 'chart-of-accounts');
    expect(result['ACCOUNTNAME']).toBe('account_name');
  });

  it('normalizes headers with spaces', () => {
    const result = autoMapFields(['Account Name'], 'sage_cloud', 'chart-of-accounts');
    expect(result['Account Name']).toBe('account_name');
  });

  it('normalizes headers with underscores', () => {
    const result = autoMapFields(['Account_Name'], 'sage_cloud', 'chart-of-accounts');
    expect(result['Account_Name']).toBe('account_name');
  });

  it('normalizes headers with hyphens', () => {
    const result = autoMapFields(['Account-Name'], 'sage_cloud', 'chart-of-accounts');
    expect(result['Account-Name']).toBe('account_name');
  });
});

// ── Unknown source system ─────────────────────────────────────────────────────

describe('autoMapFields — unknown source system', () => {
  it('falls back to generic aliases for unknown source system', () => {
    const result = autoMapFields(['AccountName'], 'unknown_system', 'chart-of-accounts');
    expect(result['AccountName']).toBe('account_name');
  });

  it('returns identity mapping for unknown step', () => {
    const result = autoMapFields(['SomeColumn'], 'sage_cloud', 'unknown-step');
    expect(result['SomeColumn']).toBe('SomeColumn');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('autoMapFields — edge cases', () => {
  it('handles empty headers array', () => {
    const result = autoMapFields([], 'sage_cloud', 'chart-of-accounts');
    expect(result).toEqual({});
  });

  it('handles multiple headers in one call — no overlap', () => {
    const headers = ['AccountNumber', 'AccountName', 'Type', 'CustomField'];
    const result = autoMapFields(headers, 'sage_cloud', 'chart-of-accounts');
    expect(Object.keys(result)).toHaveLength(4);
    expect(result['CustomField']).toBe('CustomField');
  });
});
