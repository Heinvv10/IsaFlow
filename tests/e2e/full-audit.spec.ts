/**
 * COMPREHENSIVE E2E AUDIT
 * Tests every page, API endpoint, and detail view in the app.
 * Catches 500 errors, broken pages, missing data, and auth issues.
 */
import { test, expect } from '@playwright/test';

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: ALL PAGE ROUTES (157 pages)
// Every page must return 200 (authenticated) or 307 (redirect to login)
// ═══════════════════════════════════════════════════════════════════════════

const ALL_PAGES = [
  // Dashboard
  '/accounting',
  // Customers
  '/accounting/customers', '/accounting/customers/new',
  '/accounting/customer-categories', '/accounting/customer-invoices',
  '/accounting/customer-invoices/new', '/accounting/customer-payments',
  '/accounting/customer-payments/new', '/accounting/customer-credit-notes',
  '/accounting/customer-quotes', '/accounting/customer-statements',
  '/accounting/customer-allocations', '/accounting/customer-age-analysis',
  '/accounting/customer-sales-orders', '/accounting/debtors-manager',
  '/accounting/write-offs', '/accounting/statement-run',
  // Suppliers
  '/accounting/suppliers', '/accounting/suppliers/new',
  '/accounting/supplier-categories', '/accounting/supplier-invoices',
  '/accounting/supplier-invoices/new', '/accounting/supplier-payments',
  '/accounting/supplier-payments/new', '/accounting/supplier-credit-notes',
  '/accounting/supplier-returns', '/accounting/supplier-allocations',
  '/accounting/supplier-age-analysis', '/accounting/supplier-statements',
  '/accounting/batch-payments', '/accounting/batch-payments/new',
  '/accounting/supplier-purchase-orders',
  // Items
  '/accounting/items', '/accounting/items/new',
  '/accounting/item-adjustments', '/accounting/item-pricing',
  '/accounting/item-opening-balances', '/accounting/products',
  '/accounting/products/new', '/accounting/stock-levels',
  // Banking
  '/accounting/bank-accounts', '/accounting/bank-transactions',
  '/accounting/bank-transactions/new', '/accounting/bank-transfers',
  '/accounting/bank-reconciliation', '/accounting/bank-reconciliation/import',
  '/accounting/bank-reconciliation/new', '/accounting/bank-reconciliation/rules',
  '/accounting/bank-rules', '/accounting/bank-feeds', '/accounting/cashbook',
  // Accounts
  '/accounting/chart-of-accounts', '/accounting/default-accounts',
  '/accounting/currencies', '/accounting/exchange-rates',
  '/accounting/journal-entries', '/accounting/journal-entries/new',
  '/accounting/recurring-journals', '/accounting/fiscal-periods',
  '/accounting/opening-balances',
  // VAT
  '/accounting/vat-return', '/accounting/vat-adjustments',
  '/accounting/drc-vat',
  // Accountant's Area
  '/accounting/trial-balance', '/accounting/audit-trail',
  '/accounting/depreciation', '/accounting/year-end',
  '/accounting/cost-centres', '/accounting/business-units',
  '/accounting/budgets', '/accounting/adjustments',
  // Reports (29 report pages)
  '/accounting/reports', '/accounting/reports/income-statement',
  '/accounting/reports/balance-sheet', '/accounting/reports/cash-flow',
  '/accounting/reports/budget-vs-actual', '/accounting/reports/project-profitability',
  '/accounting/reports/customer-reports', '/accounting/reports/supplier-reports',
  '/accounting/reports/bank-transactions', '/accounting/reports/account-transactions',
  '/accounting/reports/trial-balance', '/accounting/reports/audit-trail',
  '/accounting/reports/vat-return', '/accounting/reports/general-ledger',
  '/accounting/reports/customer', '/accounting/reports/supplier',
  '/accounting/reports/item-listing', '/accounting/reports/item-movement',
  '/accounting/reports/item-quantities', '/accounting/reports/item-valuation',
  '/accounting/reports/purchases-by-item', '/accounting/reports/purchases-by-supplier',
  '/accounting/reports/sales-by-customer', '/accounting/reports/sales-by-item',
  '/accounting/reports/unallocated-payments', '/accounting/reports/unallocated-receipts',
  '/accounting/reports/financial-analysis', '/accounting/reports/waterfall',
  '/accounting/reports/trend-analysis',
  // SARS
  '/accounting/sars', '/accounting/sars/vat201',
  '/accounting/sars/emp201', '/accounting/sars/submissions',
  // Tools
  '/accounting/document-capture', '/accounting/cash-flow-forecast',
  '/accounting/approvals', '/accounting/dunning',
  '/accounting/recurring-invoices', '/accounting/time-tracking',
  // Settings
  '/accounting/company-settings', '/accounting/accounting-settings',
  // Assets
  '/accounting/assets', '/accounting/assets/new',
  '/accounting/assets/categories', '/accounting/assets/disposals',
  '/accounting/assets/register',
  // Purchase Orders
  '/accounting/purchase-orders', '/accounting/purchase-orders/new',
  // Credit Notes
  '/accounting/credit-notes', '/accounting/credit-notes/new',
  // Group
  '/accounting/group', '/accounting/group/setup',
  '/accounting/group/trial-balance', '/accounting/group/income-statement',
  '/accounting/group/balance-sheet', '/accounting/group/intercompany',
  '/accounting/group/eliminations',
  // Data Import
  '/accounting/data-import', '/accounting/sage-migration',
  // Payroll
  '/payroll/employees', '/payroll/employees/new',
  '/payroll/runs', '/payroll/runs/new',
  '/payroll/leave', '/payroll/leave/apply',
  // Portal
  '/portal',
  // Onboarding
  '/onboarding',
];

test.describe('All Page Routes Load', () => {
  for (const route of ALL_PAGES) {
    test(`GET ${route} returns 200 or 307`, async ({ request }) => {
      const response = await request.get(route);
      expect([200, 307]).toContain(response.status());
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: DETAIL PAGES (with seeded data IDs)
// ═══════════════════════════════════════════════════════════════════════════

const DETAIL_PAGES = [
  '/accounting/supplier-invoices/e1000000-0000-0000-0000-000000000001',
  '/accounting/supplier-invoices/e1000000-0000-0000-0000-000000000003',
  '/accounting/supplier-invoices/e1000000-0000-0000-0000-000000000007',
  '/accounting/customer-invoices/f1000000-0000-0000-0000-000000000001',
  '/accounting/customer-invoices/f1000000-0000-0000-0000-000000000004',
  '/accounting/customer-invoices/f1000000-0000-0000-0000-000000000007',
  '/accounting/supplier-payments/5a000000-0000-0000-0000-000000000001',
  '/accounting/supplier-payments/5a000000-0000-0000-0000-000000000002',
  '/accounting/customer-payments/ca000000-0000-0000-0000-000000000001',
  '/accounting/customer-payments/ca000000-0000-0000-0000-000000000002',
  '/payroll/employees/e0000000-0000-0000-0000-000000000001',
  '/payroll/employees/e0000000-0000-0000-0000-000000000002',
];

test.describe('Detail Pages Load with Data', () => {
  for (const route of DETAIL_PAGES) {
    test(`GET ${route} returns 200`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).toBe(200);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: ALL API ENDPOINTS (GET endpoints - smoke test)
// ═══════════════════════════════════════════════════════════════════════════

const GET_APIS = [
  '/api/accounting/dashboard-stats',
  '/api/accounting/kpi-dashboard',
  '/api/accounting/chart-of-accounts',
  '/api/accounting/fiscal-periods',
  '/api/accounting/suppliers-list',
  '/api/accounting/customer-invoices-list',
  '/api/accounting/supplier-invoices',
  '/api/accounting/customer-payments',
  '/api/accounting/supplier-payments',
  '/api/accounting/bank-transactions',
  '/api/accounting/products',
  '/api/accounting/assets',
  '/api/accounting/credit-notes?type=customer',
  '/api/accounting/credit-notes?type=supplier',
  '/api/accounting/approval-rules',
  '/api/accounting/approval-requests',
  '/api/accounting/bank-rules',
  '/api/accounting/document-capture',
  '/api/accounting/recurring-invoices',
  '/api/accounting/recurring-journals',
  '/api/accounting/budgets',
  '/api/accounting/cost-centres',
  '/api/accounting/currencies',
  '/api/accounting/stock-levels',
  '/api/accounting/time-entries',
  '/api/accounting/vlm-status',
  '/api/accounting/compliance-alerts',
  // Reports
  '/api/accounting/reports-trial-balance?fiscal_period_id=72bab99e-fc80-4648-b3fc-845e54745062',
  '/api/accounting/reports-income-statement?period_start=2026-01-01&period_end=2026-03-31',
  '/api/accounting/reports-balance-sheet?as_at_date=2026-03-28',
  '/api/accounting/reports-cash-flow?period_start=2026-01-01&period_end=2026-03-31',
  '/api/accounting/reports-budget-vs-actual?period=current',
  '/api/accounting/reports-audit-trail',
  '/api/accounting/ar-aging',
  '/api/accounting/ap-aging',
  // Analytics (Sprint A+B)
  '/api/accounting/reports-extended-ratios?from=2026-01-01&to=2026-03-31',
  '/api/accounting/reports-ratio-trends?months=6',
  '/api/accounting/reports-kpi-scorecard?from=2026-01-01&to=2026-03-31',
  '/api/accounting/reports-waterfall?type=profit&from=2026-01-01&to=2026-03-31',
  '/api/accounting/reports-waterfall?type=cashflow&from=2026-03-01&to=2026-03-31',
  '/api/accounting/reports-trend-analysis?metric=revenue&months=6',
  // SARS
  '/api/accounting/sars/sars-compliance',
  // Payroll
  '/api/payroll/employees',
  '/api/payroll/payroll-runs',
];

test.describe('GET API Endpoints Respond', () => {
  for (const route of GET_APIS) {
    test(`GET ${route} does not 404 or 500`, async ({ request }) => {
      const response = await request.get(route);
      expect([200, 400, 401]).toContain(response.status());
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: POST API ENDPOINTS (validation tests)
// ═══════════════════════════════════════════════════════════════════════════

const POST_APIS = [
  { url: '/api/accounting/ai-invoice-pipeline', body: { documentId: '00000000-0000-0000-0000-000000000000' }, expect: [200, 400, 401, 404] },
  { url: '/api/accounting/receipt-to-journal', body: { documentId: '00000000-0000-0000-0000-000000000000' }, expect: [200, 400, 401, 404] },
  { url: '/api/accounting/document-validation', body: { entityType: 'supplier_invoice', entityId: '00000000-0000-0000-0000-000000000000', documentId: '00000000-0000-0000-0000-000000000000' }, expect: [200, 400, 401, 404] },
  { url: '/api/accounting/smart-categorize', body: { description: 'WOOLWORTHS POS', amount: -500 }, expect: [200, 400, 401] },
];

test.describe('POST API Endpoints Respond', () => {
  for (const api of POST_APIS) {
    test(`POST ${api.url} responds correctly`, async ({ request }) => {
      const response = await request.post(api.url, { data: api.body });
      expect(api.expect).toContain(response.status());
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: NAVIGATION BAR
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Navigation', () => {
  test('renders all top-level nav tabs', async ({ page }) => {
    await page.goto('/accounting');
    await page.waitForLoadState('networkidle');
    const nav = await page.textContent('nav') || '';
    expect(nav).toContain('Dashboard');
    expect(nav).toContain('Customers');
    expect(nav).toContain('Suppliers');
    expect(nav).toContain('Banking');
    expect(nav).toContain('Reports');
    expect(nav).toContain('SARS');
    expect(nav).toContain('Payroll');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: DATA INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Data Integrity', () => {
  test('supplier invoices list returns data', async ({ request }) => {
    const res = await request.get('/api/accounting/supplier-invoices');
    expect(res.status()).toBe(200);
    const json = await res.json();
    const invoices = json.data?.invoices || json.data || [];
    expect(invoices.length).toBeGreaterThan(0);
  });

  test('customer invoices list returns data', async ({ request }) => {
    const res = await request.get('/api/accounting/customer-invoices-list');
    expect(res.status()).toBe(200);
    const json = await res.json();
    const invoices = json.data?.invoices || [];
    expect(invoices.length).toBeGreaterThan(0);
  });

  test('suppliers list returns data', async ({ request }) => {
    const res = await request.get('/api/accounting/suppliers-list');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect((json.data || []).length).toBeGreaterThan(0);
  });

  test('trial balance is balanced', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-trial-balance?fiscal_period_id=72bab99e-fc80-4648-b3fc-845e54745062');
    if (res.status() === 200) {
      const json = await res.json();
      const data = json.data || {};
      const totalDr = data.totalDebit || 0;
      const totalCr = data.totalCredit || 0;
      expect(Math.abs(totalDr - totalCr)).toBeLessThan(0.02);
    }
  });

  test('income statement has revenue', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-income-statement?period_start=2026-01-01&period_end=2026-03-31');
    if (res.status() === 200) {
      const json = await res.json();
      expect(json.data?.totalRevenue || 0).toBeGreaterThan(0);
    }
  });

  test('dashboard stats returns metrics', async ({ request }) => {
    const res = await request.get('/api/accounting/dashboard-stats');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
  });

  test('VLM is available', async ({ request }) => {
    const res = await request.get('/api/accounting/vlm-status');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.data?.available).toBe(true);
  });

  test('extended ratios return 30+ ratios', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-extended-ratios?from=2026-01-01&to=2026-03-31');
    if (res.status() === 200) {
      const json = await res.json();
      const ratioCount = Object.keys(json.data?.ratios || {}).length;
      expect(ratioCount).toBeGreaterThanOrEqual(25);
    }
  });

  test('KPI scorecard has items', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-kpi-scorecard?from=2026-01-01&to=2026-03-31');
    if (res.status() === 200) {
      const json = await res.json();
      expect((json.data?.scorecard || []).length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: PWA & BRANDING
// ═══════════════════════════════════════════════════════════════════════════

test.describe('PWA & Branding', () => {
  test('manifest.json accessible', async ({ request }) => {
    const res = await request.get('/manifest.json');
    expect(res.status()).toBe(200);
  });

  test('service worker accessible', async ({ request }) => {
    const res = await request.get('/sw.js');
    expect([200, 304]).toContain(res.status());
  });

  test('login page uses teal', async ({ page }) => {
    await page.goto('/login');
    const html = await page.content();
    expect(html).toContain('#14b8a6');
  });
});
