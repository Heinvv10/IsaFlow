// RED phase — written before implementation
/**
 * Reporting & Tax Compliance — Pure Function Unit Tests
 *
 * Services covered:
 *   - src/lib/csv.ts                                  (csvCell, csvVal, escapeCsv)
 *   - customReportFieldDefs.ts                         (getAvailableFields, getFieldDef, getBaseQuery, getCompanyAlias)
 *   - casewareExportService.ts                         (suggestCaseWareCode — sync map lookup wrapped in async)
 *
 * Services with NO pure exported functions (all exports require sql / DB):
 *   - disclosureNoteService.ts         → async, sql-dependent
 *   - disclosureNoteGenerators.ts      → async, sql-dependent (fmt/fiscalRange are unexported internals)
 *   - customReportService.ts           → async, sql-dependent
 *   - vat201Service.ts                 → async, sql-dependent (roundCents is unexported)
 *   - vatReturnService.ts              → async, sql-dependent
 *   - kpiService.ts                    → facade re-export, no own logic
 *   - kpiChartsService.ts              → async, sql-dependent
 *   - kpiDashboardService.ts           → async, sql-dependent
 *   - consolidatedReportingService.ts  → async, sql-dependent
 *   - consolidatedTrialBalanceService.ts → async, sql-dependent
 *
 * The @/lib/neon module is stubbed so that importing casewareExportService
 * (which calls sql at module level via the neon client initialisation) does
 * not throw "DATABASE_URL is not set" during test collection.
 *
 * Target: 40+ test cases across pure-logic surface.
 */

import { describe, it, expect, vi } from 'vitest';

// Stub @/lib/neon before any service imports reach it.
// suggestCaseWareCode never actually calls sql at runtime — the stub is only
// needed to satisfy the module graph at import time.
vi.mock('@/lib/neon', () => {
  const noopTag = () => Promise.resolve([]);
  (noopTag as unknown as Record<string, unknown>).unsafe = (s: string) => s;
  return { sql: noopTag, transaction: (_cb: unknown) => Promise.resolve() };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { csvCell, csvVal, escapeCsv } from '@/lib/csv';
import {
  getAvailableFields,
  getFieldDef,
  getBaseQuery,
  getCompanyAlias,
} from '@/modules/accounting/services/reports/customReportFieldDefs';
import { suggestCaseWareCode } from '@/modules/accounting/services/reports/casewareExportService';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CSV Utilities (src/lib/csv.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe('csvCell', () => {
  it('wraps a plain string in double-quotes', () => {
    expect(csvCell('Acme Pty Ltd')).toBe('"Acme Pty Ltd"');
  });

  it('wraps a ZAR currency number in double-quotes', () => {
    expect(csvCell(123456.78)).toBe('"123456.78"');
  });

  it('converts null to an empty quoted cell', () => {
    expect(csvCell(null)).toBe('""');
  });

  it('converts undefined to an empty quoted cell', () => {
    expect(csvCell(undefined)).toBe('""');
  });

  it('escapes internal double-quotes by doubling them (RFC 4180)', () => {
    expect(csvCell('Say "hello"')).toBe('"Say ""hello"""');
  });

  it('prepends a single-quote to values starting with = to prevent formula injection', () => {
    expect(csvCell('=SUM(A1:A10)')).toBe('"\'=SUM(A1:A10)"');
  });

  it('prepends a single-quote to values starting with + (formula injection)', () => {
    expect(csvCell('+CMD')).toBe('"\'+CMD"');
  });

  it('prepends a single-quote to values starting with - (formula injection)', () => {
    expect(csvCell('-1+1')).toBe('"\'-1+1"');
  });

  it('prepends a single-quote to values starting with @ (formula injection)', () => {
    expect(csvCell('@SUM')).toBe('"\'@SUM"');
  });

  it('handles a zero value correctly', () => {
    expect(csvCell(0)).toBe('"0"');
  });

  it('prepends single-quote to negative ZAR amounts because String(-500) starts with -', () => {
    // String(-500) === "-500" which starts with '-', so the sanitizer fires.
    // Both the numeric literal and the string literal trigger formula-injection protection.
    expect(csvCell(-500.00)).toBe('"\'-500"');
    expect(csvCell('-500.00')).toBe('"\'-500.00"');
  });

  it('handles multi-line content by wrapping in quotes', () => {
    const multiline = 'Line 1\nLine 2';
    expect(csvCell(multiline)).toBe('"Line 1\nLine 2"');
  });

  it('handles content with commas (no extra escaping needed — already quoted)', () => {
    expect(csvCell('100,000.00')).toBe('"100,000.00"');
  });
});

describe('csvVal', () => {
  it('behaves identically to csvCell for a plain string', () => {
    expect(csvVal('Brightsphere (Pty) Ltd')).toBe(csvCell('Brightsphere (Pty) Ltd'));
  });

  it('behaves identically to csvCell for null', () => {
    expect(csvVal(null)).toBe(csvCell(null));
  });

  it('behaves identically to csvCell for a ZAR number', () => {
    expect(csvVal(9999.99)).toBe(csvCell(9999.99));
  });

  it('behaves identically to csvCell for formula-injection strings', () => {
    expect(csvVal('=HYPERLINK("evil.com")')).toBe(csvCell('=HYPERLINK("evil.com")'));
  });
});

describe('escapeCsv', () => {
  it('returns a plain string unchanged when no quoting is needed', () => {
    expect(escapeCsv('B10')).toBe('B10');
  });

  it('returns empty string for null', () => {
    expect(escapeCsv(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeCsv(undefined)).toBe('');
  });

  it('wraps in quotes when the value contains a comma', () => {
    expect(escapeCsv('Acme, Ltd')).toBe('"Acme, Ltd"');
  });

  it('wraps in quotes and doubles internal quotes when value contains double-quote', () => {
    expect(escapeCsv('The "Big" Fund')).toBe('"The ""Big"" Fund"');
  });

  it('wraps in quotes when value contains a newline', () => {
    expect(escapeCsv('line1\nline2')).toBe('"line1\nline2"');
  });

  it('prepends single-quote to formula-injection prefix before quoting', () => {
    const result = escapeCsv('=BAD()');
    // sanitised to '=BAD() — no comma/quote/newline so no outer quotes
    expect(result).toBe("'=BAD()");
  });

  it('prepends single-quote AND wraps when formula-injection value also has a comma', () => {
    const result = escapeCsv('=A1,B1');
    expect(result).toBe('"\'=A1,B1"');
  });

  it('converts a number to its string representation', () => {
    expect(escapeCsv(42)).toBe('42');
  });

  it('returns empty string for zero passed as 0', () => {
    // 0 → "0", not empty
    expect(escapeCsv(0)).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Custom Report Field Definitions (customReportFieldDefs.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe('getAvailableFields', () => {
  it('returns field definitions for gl_transactions', () => {
    const fields = getAvailableFields('gl_transactions');
    expect(fields.length).toBeGreaterThan(0);
    const fieldNames = fields.map(f => f.field);
    expect(fieldNames).toContain('entry_date');
    expect(fieldNames).toContain('debit');
    expect(fieldNames).toContain('credit');
  });

  it('returns field definitions for customer_invoices', () => {
    const fields = getAvailableFields('customer_invoices');
    const fieldNames = fields.map(f => f.field);
    expect(fieldNames).toContain('invoice_number');
    expect(fieldNames).toContain('total');
    expect(fieldNames).toContain('balance');
  });

  it('returns field definitions for supplier_invoices', () => {
    const fields = getAvailableFields('supplier_invoices');
    const fieldNames = fields.map(f => f.field);
    expect(fieldNames).toContain('invoice_number');
    expect(fieldNames).toContain('supplier_name');
    expect(fieldNames).toContain('balance');
  });

  it('returns field definitions for bank_transactions', () => {
    const fields = getAvailableFields('bank_transactions');
    const fieldNames = fields.map(f => f.field);
    expect(fieldNames).toContain('date');
    expect(fieldNames).toContain('amount');
    expect(fieldNames).toContain('bank_account');
  });

  it('returns field definitions for customers', () => {
    const fields = getAvailableFields('customers');
    const fieldNames = fields.map(f => f.field);
    expect(fieldNames).toContain('name');
    expect(fieldNames).toContain('vat_number');
    expect(fieldNames).toContain('balance');
  });

  it('returns field definitions for suppliers', () => {
    const fields = getAvailableFields('suppliers');
    const fieldNames = fields.map(f => f.field);
    expect(fieldNames).toContain('name');
    expect(fieldNames).toContain('credit_limit');
  });

  it('returns field definitions for items', () => {
    const fields = getAvailableFields('items');
    const fieldNames = fields.map(f => f.field);
    expect(fieldNames).toContain('item_code');
    expect(fieldNames).toContain('selling_price');
    expect(fieldNames).toContain('quantity_on_hand');
  });

  it('returns an empty array for an unknown data source', () => {
    expect(getAvailableFields('unknown_source')).toEqual([]);
  });

  it('returns an empty array for an empty string data source', () => {
    expect(getAvailableFields('')).toEqual([]);
  });

  it('marks currency fields as totalable in customer_invoices', () => {
    const fields = getAvailableFields('customer_invoices');
    const totalField = fields.find(f => f.field === 'total');
    expect(totalField?.totalable).toBe(true);
    expect(totalField?.type).toBe('currency');
  });

  it('marks non-numeric fields as not totalable in gl_transactions', () => {
    const fields = getAvailableFields('gl_transactions');
    const entryDateField = fields.find(f => f.field === 'entry_date');
    expect(entryDateField?.totalable).toBe(false);
  });

  it('every field definition has a non-empty sqlExpr', () => {
    const dataSources = ['gl_transactions', 'customer_invoices', 'supplier_invoices', 'bank_transactions', 'customers', 'suppliers', 'items'];
    for (const ds of dataSources) {
      const fields = getAvailableFields(ds);
      for (const f of fields) {
        expect(f.sqlExpr, `${ds}.${f.field} sqlExpr must not be empty`).toBeTruthy();
      }
    }
  });
});

describe('getFieldDef', () => {
  it('returns the correct field definition for a known field', () => {
    const def = getFieldDef('gl_transactions', 'debit');
    expect(def).toBeDefined();
    expect(def?.label).toBe('Debit');
    expect(def?.type).toBe('currency');
    expect(def?.sqlExpr).toBe('jl.debit_amount');
  });

  it('returns undefined for a field that does not exist in the data source', () => {
    expect(getFieldDef('gl_transactions', 'nonexistent_column')).toBeUndefined();
  });

  it('returns undefined for an unknown data source', () => {
    expect(getFieldDef('ghost_source', 'debit')).toBeUndefined();
  });

  it('returns the balance field with correct sqlExpr for customer_invoices', () => {
    const def = getFieldDef('customer_invoices', 'balance');
    expect(def?.sqlExpr).toBe('(ci.total_amount - ci.amount_paid)');
  });

  it('returns the vat_number field for suppliers', () => {
    const def = getFieldDef('suppliers', 'vat_number');
    expect(def).toBeDefined();
    expect(def?.filterable).toBe(true);
    expect(def?.totalable).toBe(false);
  });

  it('returns quantity_on_hand as type number not currency', () => {
    const def = getFieldDef('items', 'quantity_on_hand');
    expect(def?.type).toBe('number');
    expect(def?.totalable).toBe(true);
  });
});

describe('getBaseQuery', () => {
  it('returns a FROM clause containing gl_journal_entries for gl_transactions', () => {
    const q = getBaseQuery('gl_transactions');
    expect(q).toContain('gl_journal_entries');
    expect(q).toContain('gl_journal_lines');
    expect(q).toContain('gl_accounts');
  });

  it('returns a FROM clause for customer_invoices', () => {
    const q = getBaseQuery('customer_invoices');
    expect(q).toContain('customer_invoices ci');
    expect(q).toContain('customers c');
  });

  it('returns a FROM clause for supplier_invoices', () => {
    const q = getBaseQuery('supplier_invoices');
    expect(q).toContain('supplier_invoices si');
    expect(q).toContain('suppliers s');
  });

  it('returns a FROM clause for bank_transactions', () => {
    const q = getBaseQuery('bank_transactions');
    expect(q).toContain('bank_transactions bt');
    expect(q).toContain('bank_accounts ba');
  });

  it('returns a simple FROM clause for customers', () => {
    const q = getBaseQuery('customers');
    expect(q).toBe('FROM customers c');
  });

  it('returns a simple FROM clause for suppliers', () => {
    const q = getBaseQuery('suppliers');
    expect(q).toBe('FROM suppliers s');
  });

  it('returns a simple FROM clause for items', () => {
    const q = getBaseQuery('items');
    expect(q).toBe('FROM items i');
  });

  it('returns an empty string for an unknown data source', () => {
    expect(getBaseQuery('does_not_exist')).toBe('');
  });
});

describe('getCompanyAlias', () => {
  it('returns je for gl_transactions', () => {
    expect(getCompanyAlias('gl_transactions')).toBe('je');
  });

  it('returns ci for customer_invoices', () => {
    expect(getCompanyAlias('customer_invoices')).toBe('ci');
  });

  it('returns si for supplier_invoices', () => {
    expect(getCompanyAlias('supplier_invoices')).toBe('si');
  });

  it('returns bt for bank_transactions', () => {
    expect(getCompanyAlias('bank_transactions')).toBe('bt');
  });

  it('returns c for customers', () => {
    expect(getCompanyAlias('customers')).toBe('c');
  });

  it('returns s for suppliers', () => {
    expect(getCompanyAlias('suppliers')).toBe('s');
  });

  it('returns i for items', () => {
    expect(getCompanyAlias('items')).toBe('i');
  });

  it('returns empty string for an unknown data source', () => {
    expect(getCompanyAlias('mystery_table')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CaseWare Code Suggestion (casewareExportService.ts)
//    suggestCaseWareCode is declared async but performs a pure synchronous
//    map lookup — no DB access, safe to test directly.
// ─────────────────────────────────────────────────────────────────────────────

describe('suggestCaseWareCode', () => {
  it('maps asset:bank to B10 Cash and cash equivalents', async () => {
    const result = await suggestCaseWareCode('asset', 'bank');
    expect(result.code).toBe('B10');
    expect(result.label).toBe('Cash and cash equivalents');
  });

  it('maps asset:cash to B10', async () => {
    const result = await suggestCaseWareCode('asset', 'cash');
    expect(result.code).toBe('B10');
  });

  it('maps asset:petty_cash to B10', async () => {
    const result = await suggestCaseWareCode('asset', 'petty_cash');
    expect(result.code).toBe('B10');
  });

  it('maps asset:receivable to B20 Trade receivables', async () => {
    const result = await suggestCaseWareCode('asset', 'receivable');
    expect(result.code).toBe('B20');
    expect(result.label).toBe('Trade receivables');
  });

  it('maps asset:inventory to B30 Inventories', async () => {
    const result = await suggestCaseWareCode('asset', 'inventory');
    expect(result.code).toBe('B30');
    expect(result.label).toBe('Inventories');
  });

  it('maps asset:fixed_asset to B40 Property, plant and equipment', async () => {
    const result = await suggestCaseWareCode('asset', 'fixed_asset');
    expect(result.code).toBe('B40');
    expect(result.label).toBe('Property, plant and equipment');
  });

  it('maps unknown asset subtype to B90 Other assets via generic fallback', async () => {
    const result = await suggestCaseWareCode('asset', 'prepayment');
    expect(result.code).toBe('B90');
    expect(result.label).toBe('Other assets');
  });

  it('maps asset with null subtype to B90 via generic fallback', async () => {
    const result = await suggestCaseWareCode('asset', null);
    expect(result.code).toBe('B90');
  });

  it('maps liability:payable to C10 Trade payables', async () => {
    const result = await suggestCaseWareCode('liability', 'payable');
    expect(result.code).toBe('C10');
    expect(result.label).toBe('Trade payables');
  });

  it('maps liability:tax_payable to C20 Tax payable', async () => {
    const result = await suggestCaseWareCode('liability', 'tax_payable');
    expect(result.code).toBe('C20');
    expect(result.label).toBe('Tax payable');
  });

  it('maps liability:vat_output to C20 Tax payable', async () => {
    const result = await suggestCaseWareCode('liability', 'vat_output');
    expect(result.code).toBe('C20');
  });

  it('maps liability:loan to C30 Borrowings', async () => {
    const result = await suggestCaseWareCode('liability', 'loan');
    expect(result.code).toBe('C30');
    expect(result.label).toBe('Borrowings');
  });

  it('maps unknown liability subtype to C90 Other liabilities via generic fallback', async () => {
    const result = await suggestCaseWareCode('liability', 'deferred_revenue');
    expect(result.code).toBe('C90');
    expect(result.label).toBe('Other liabilities');
  });

  it('maps equity with null subtype to D10 Share capital', async () => {
    const result = await suggestCaseWareCode('equity', null);
    expect(result.code).toBe('D10');
    expect(result.label).toBe('Share capital');
  });

  it('maps equity:retained to D20 Retained earnings', async () => {
    const result = await suggestCaseWareCode('equity', 'retained');
    expect(result.code).toBe('D20');
    expect(result.label).toBe('Retained earnings');
  });

  it('maps revenue with null subtype to E10 Revenue', async () => {
    const result = await suggestCaseWareCode('revenue', null);
    expect(result.code).toBe('E10');
    expect(result.label).toBe('Revenue');
  });

  it('maps expense:cost_of_sales to F05 Cost of sales', async () => {
    const result = await suggestCaseWareCode('expense', 'cost_of_sales');
    expect(result.code).toBe('F05');
    expect(result.label).toBe('Cost of sales');
  });

  it('maps expense with null subtype to F10 Operating expenses', async () => {
    const result = await suggestCaseWareCode('expense', null);
    expect(result.code).toBe('F10');
    expect(result.label).toBe('Operating expenses');
  });

  it('maps expense:salary to F10 Operating expenses via generic fallback', async () => {
    const result = await suggestCaseWareCode('expense', 'salary');
    expect(result.code).toBe('F10');
  });

  it('returns Z99 Unclassified for a completely unknown account type', async () => {
    const result = await suggestCaseWareCode('unknown_type', null);
    expect(result.code).toBe('Z99');
    expect(result.label).toBe('Unclassified');
  });

  it('returns Z99 for an empty account type string', async () => {
    const result = await suggestCaseWareCode('', null);
    expect(result.code).toBe('Z99');
  });

  it('specific key takes priority over generic key for the same type', async () => {
    // asset:fixed_asset (B40) must win over asset: generic (B90)
    const specific = await suggestCaseWareCode('asset', 'fixed_asset');
    const generic  = await suggestCaseWareCode('asset', 'something_else');
    expect(specific.code).toBe('B40');
    expect(generic.code).toBe('B90');
    expect(specific.code).not.toBe(generic.code);
  });
});
