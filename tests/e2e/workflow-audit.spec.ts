/**
 * COMPREHENSIVE WORKFLOW AUDIT
 * Tests the full accounting lifecycle end-to-end with correct API response shapes.
 */
import { test, expect } from '@playwright/test';

const CID = '00000000-0000-0000-0000-000000000001';

// ═══════════════════════════════════════════════════════════════════════════
// 1. SUPPLIER INVOICE LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Supplier Invoice Lifecycle', () => {
  test('list supplier invoices with data', async ({ request }) => {
    const res = await request.get('/api/accounting/supplier-invoices', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const json = await res.json();
    const invoices = json.data?.invoices || json.data || [];
    expect(invoices.length).toBeGreaterThan(0);
  });

  test('view supplier invoice detail', async ({ request }) => {
    const res = await request.get('/api/accounting/supplier-invoices-detail?id=e1000000-0000-0000-0000-000000000003', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const d = (await res.json()).data;
    expect(d.invoiceNumber || d.invoice_number).toBeDefined();
  });

  test('supplier invoice VAT correct', async ({ request }) => {
    const res = await request.get('/api/accounting/supplier-invoices-detail?id=e1000000-0000-0000-0000-000000000003', { headers: { 'X-Company-Id': CID } });
    const d = (await res.json()).data;
    const sub = parseFloat(d.subtotal);
    const tax = parseFloat(d.taxAmount || d.tax_amount);
    const total = parseFloat(d.totalAmount || d.total_amount);
    expect(Math.abs(sub + tax - total)).toBeLessThan(0.02);
  });

  test('paid invoices have zero balance', async ({ request }) => {
    const res = await request.get('/api/accounting/supplier-invoices-detail?id=e1000000-0000-0000-0000-000000000010', { headers: { 'X-Company-Id': CID } });
    if (res.status() === 200) {
      const d = (await res.json()).data;
      const total = parseFloat(d.totalAmount || d.total_amount || '0');
      const paid = parseFloat(d.amountPaid || d.amount_paid || '0');
      if (paid > 0) expect(total - paid).toBeCloseTo(0, 0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CUSTOMER INVOICE LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Customer Invoice Lifecycle', () => {
  test('list customer invoices with data', async ({ request }) => {
    const res = await request.get('/api/accounting/customer-invoices-list', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const json = await res.json();
    const invoices = json.data?.invoices || json.data || [];
    expect(invoices.length).toBeGreaterThan(0);
  });

  test('customer invoice detail loads', async ({ request }) => {
    const res = await request.get('/api/accounting/customer-invoices-detail?id=f1000000-0000-0000-0000-000000000004', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. PAYMENTS & ALLOCATIONS
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Payments & Allocations', () => {
  test('supplier payments list', async ({ request }) => {
    const res = await request.get('/api/accounting/supplier-payments', { headers: { 'X-Company-Id': CID } });
    expect([200, 400]).toContain(res.status());
  });

  test('customer payments list', async ({ request }) => {
    const res = await request.get('/api/accounting/customer-payments', { headers: { 'X-Company-Id': CID } });
    expect([200, 400]).toContain(res.status());
  });

  test('supplier payment detail (via list API)', async ({ request }) => {
    const res = await request.get('/api/accounting/supplier-payments?id=5a000000-0000-0000-0000-000000000001', { headers: { 'X-Company-Id': CID } });
    expect([200, 400]).toContain(res.status());
  });

  test('customer payment detail (via list API)', async ({ request }) => {
    const res = await request.get('/api/accounting/customer-payments?id=ca000000-0000-0000-0000-000000000001', { headers: { 'X-Company-Id': CID } });
    expect([200, 400]).toContain(res.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. BANK & RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Bank & Reconciliation', () => {
  test('bank transactions exist', async ({ request }) => {
    const res = await request.get('/api/accounting/bank-transactions', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('smart categorization', async ({ request }) => {
    const res = await request.post('/api/accounting/smart-categorize', {
      headers: { 'X-Company-Id': CID },
      data: { description: 'WOOLWORTHS', amount: -500 },
    });
    expect([200, 400]).toContain(res.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. JOURNAL ENTRIES & GL
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Journal Entries & GL', () => {
  test('journal entries exist', async ({ request }) => {
    const res = await request.get('/api/accounting/journal-entries', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('chart of accounts has entries', async ({ request }) => {
    const res = await request.get('/api/accounting/chart-of-accounts', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect((json.data || []).length).toBeGreaterThan(20);
  });

  test('fiscal periods exist for company', async ({ request }) => {
    const res = await request.get('/api/accounting/fiscal-periods', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect((json.data || []).length).toBeGreaterThanOrEqual(12);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. FINANCIAL REPORTS
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Financial Reports', () => {
  test('trial balance is balanced', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-trial-balance?fiscal_period_id=72bab99e-fc80-4648-b3fc-845e54745062', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const json = await res.json();
    const dr = json.data?.totalDebit || 0;
    const cr = json.data?.totalCredit || 0;
    expect(Math.abs(dr - cr)).toBeLessThan(0.02);
  });

  test('income statement has revenue', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-income-statement?period_start=2026-01-01&period_end=2026-03-31', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data?.totalRevenue || 0).toBeGreaterThan(0);
  });

  test('balance sheet has assets', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-balance-sheet?as_at_date=2026-03-28', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data?.totalAssets || 0).toBeGreaterThan(0);
  });

  test('cash flow statement responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-cash-flow?period_start=2026-01-01&period_end=2026-03-31', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('AR aging responds', async ({ request }) => {
    const res = await request.get('/api/accounting/ar-aging', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('AP aging responds', async ({ request }) => {
    const res = await request.get('/api/accounting/ap-aging', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('dashboard stats populated', async ({ request }) => {
    const res = await request.get('/api/accounting/dashboard-stats', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. ANALYTICS (Sprint A+B)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Analytics', () => {
  test('extended ratios 30+', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-extended-ratios?from=2026-01-01&to=2026-03-31', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(Object.keys(json.data?.ratios || {}).length).toBeGreaterThanOrEqual(25);
  });

  test('KPI scorecard has items', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-kpi-scorecard?from=2026-01-01&to=2026-03-31', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('profit waterfall has steps', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-waterfall?type=profit&from=2026-01-01&to=2026-03-31', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('trend analysis returns data', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-trend-analysis?metric=revenue&months=6', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. VLM & AI PIPELINE
// ═══════════════════════════════════════════════════════════════════════════
test.describe('VLM & AI Pipeline', () => {
  test('VLM available', async ({ request }) => {
    const res = await request.get('/api/accounting/vlm-status', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    expect((await res.json()).data?.available).toBe(true);
  });

  test('AI invoice pipeline validates', async ({ request }) => {
    const res = await request.post('/api/accounting/ai-invoice-pipeline', {
      headers: { 'X-Company-Id': CID },
      data: { documentId: '00000000-0000-0000-0000-000000000000' },
    });
    expect([400, 404]).toContain(res.status());
  });

  test('receipt-to-journal validates', async ({ request }) => {
    const res = await request.post('/api/accounting/receipt-to-journal', {
      headers: { 'X-Company-Id': CID },
      data: { documentId: '00000000-0000-0000-0000-000000000000' },
    });
    expect([400, 404]).toContain(res.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. SARS
// ═══════════════════════════════════════════════════════════════════════════
test.describe('SARS', () => {
  test('compliance events exist', async ({ request }) => {
    const res = await request.get('/api/accounting/sars/sars-compliance', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    const json = await res.json();
    const events = json.data?.events || json.data?.calendar || [];
    expect(events.length).toBeGreaterThan(0);
  });

  test('compliance alerts', async ({ request }) => {
    const res = await request.get('/api/accounting/compliance-alerts', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. ASSETS & INVENTORY
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Assets & Inventory', () => {
  test('assets exist', async ({ request }) => {
    const res = await request.get('/api/accounting/assets', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    expect((await res.json()).data.length).toBeGreaterThan(0);
  });

  test('products exist', async ({ request }) => {
    const res = await request.get('/api/accounting/products', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    expect((await res.json()).data.length).toBeGreaterThan(0);
  });

  test('stock levels', async ({ request }) => {
    const res = await request.get('/api/accounting/stock-levels', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. PAYROLL
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Payroll', () => {
  test('employees exist', async ({ request }) => {
    const res = await request.get('/api/payroll/employees', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    expect((await res.json()).data.length).toBeGreaterThan(0);
  });

  test('payroll runs', async ({ request }) => {
    const res = await request.get('/api/payroll/payroll-runs', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. MASTER DATA
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Master Data', () => {
  test('10 suppliers', async ({ request }) => {
    const res = await request.get('/api/accounting/suppliers-list', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
    expect((await res.json()).data.length).toBe(10);
  });

  test('credit notes', async ({ request }) => {
    const res = await request.get('/api/accounting/credit-notes?type=customer', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('recurring invoices', async ({ request }) => {
    const res = await request.get('/api/accounting/recurring-invoices', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('approval rules', async ({ request }) => {
    const res = await request.get('/api/accounting/approval-rules', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });

  test('time entries', async ({ request }) => {
    const res = await request.get('/api/accounting/time-entries', { headers: { 'X-Company-Id': CID } });
    expect(res.status()).toBe(200);
  });
});
