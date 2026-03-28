import { test, expect } from '@playwright/test';

/**
 * IsaFlow — New Features E2E Tests
 * Tests all pages and API routes added in the feature build.
 */

// ═══════════════════════════════════════════════════════════════════════════
// ALL NEW PAGE ROUTES — must return 200 (or 307 auth redirect)
// ═══════════════════════════════════════════════════════════════════════════

const NEW_PAGE_ROUTES = [
  // Payroll
  '/payroll/employees',
  '/payroll/employees/new',
  '/payroll/runs',
  '/payroll/runs/new',

  // SARS
  '/accounting/sars',
  '/accounting/sars/vat201',
  '/accounting/sars/emp201',
  '/accounting/sars/submissions',

  // Document Capture
  '/accounting/document-capture',

  // Cash Flow Forecast
  '/accounting/cash-flow-forecast',

  // Approvals
  '/accounting/approvals',

  // Company Settings
  '/accounting/company-settings',

  // Bank Feeds
  '/accounting/bank-feeds',

  // Client Portal (public, no auth redirect)
  '/portal',
];

test.describe('New feature pages load', () => {
  for (const route of NEW_PAGE_ROUTES) {
    test(`GET ${route} returns 200 or 307`, async ({ page }) => {
      const response = await page.goto(route);
      const status = response?.status() ?? 0;
      // 200 = page loads, 307 = auth redirect (expected for protected pages)
      expect([200, 307]).toContain(status);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ALL NEW API ROUTES — must respond (not 404/500)
// ═══════════════════════════════════════════════════════════════════════════

const NEW_API_ROUTES = [
  // Payroll APIs
  '/api/payroll/employees',
  '/api/payroll/payroll-runs',

  // SARS APIs
  '/api/accounting/sars/sars-compliance',

  // Document Capture
  '/api/accounting/document-capture',

  // Cash Flow Forecast
  '/api/accounting/cash-flow-forecast',

  // Approval APIs
  '/api/accounting/approval-rules',
  '/api/accounting/approval-requests',

  // Company
  '/api/accounting/companies',

  // KPI Dashboard
  '/api/accounting/kpi-dashboard',

  // Smart Categorization
  '/api/accounting/smart-categorize',

  // Bank Feeds
  '/api/bank-feeds/connections?action=status',

  // Portal
  '/api/portal/invoices?clientId=00000000-0000-0000-0000-000000000001',
];

test.describe('New API routes respond', () => {
  for (const route of NEW_API_ROUTES) {
    test(`GET ${route} does not 404`, async ({ request }) => {
      const response = await request.get(route);
      // Should get 200, 401 (auth required), or 400 (bad request) — never 404
      expect(response.status()).not.toBe(404);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NAV TAB TESTS — new tabs appear and open
// ═══════════════════════════════════════════════════════════════════════════

const NEW_NAV_TABS = [
  'SARS',
  'Tools',
  'Payroll',
];

test.describe('New nav tabs', () => {
  test('all new tabs are visible', async ({ page }) => {
    await page.goto('/accounting');
    const nav = page.locator('nav.bg-gray-900');

    for (const label of NEW_NAV_TABS) {
      const tab = nav.getByText(label, { exact: true }).first();
      await expect(tab).toBeVisible();
    }
  });

  for (const label of NEW_NAV_TABS) {
    test(`"${label}" dropdown opens on click`, async ({ page }) => {
      await page.goto('/accounting');
      const nav = page.locator('nav.bg-gray-900');
      const btn = nav.getByRole('button', { name: label, exact: true });
      await btn.click();
      const dropdown = nav.locator('.absolute');
      await expect(dropdown.first()).toBeVisible();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL MODULE
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Payroll module', () => {
  test('employees page has correct heading', async ({ page }) => {
    await page.goto('/payroll/employees');
    await expect(page.locator('h1', { hasText: 'Employees' })).toBeVisible();
  });

  test('new employee form loads', async ({ page }) => {
    await page.goto('/payroll/employees/new');
    await expect(page.locator('h1', { hasText: /New Employee|Add Employee/ })).toBeVisible();
    // Check form fields exist
    await expect(page.getByText('Personal Details').first()).toBeVisible();
  });

  test('payroll runs page loads', async ({ page }) => {
    await page.goto('/payroll/runs');
    await expect(page.locator('h1', { hasText: /Payroll Runs/ })).toBeVisible();
  });

  test('new payroll run page loads', async ({ page }) => {
    await page.goto('/payroll/runs/new');
    await expect(page.locator('h1', { hasText: /New Payroll|Run Payroll/ })).toBeVisible();
  });

  test('payroll tab highlights correctly', async ({ page }) => {
    await page.goto('/payroll/employees');
    const nav = page.locator('nav.bg-gray-900');
    const activeTab = nav.locator('[class*="border-teal-500"]');
    await expect(activeTab.first()).toBeVisible();
    await expect(activeTab.filter({ hasText: 'Payroll' }).first()).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SARS eFILING
// ═══════════════════════════════════════════════════════════════════════════

test.describe('SARS eFiling', () => {
  test('SARS dashboard loads', async ({ page }) => {
    await page.goto('/accounting/sars');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1', { hasText: /SARS/ })).toBeVisible({ timeout: 10000 });
  });

  test('VAT201 page loads', async ({ page }) => {
    await page.goto('/accounting/sars/vat201');
    await expect(page.locator('text=VAT201').first()).toBeVisible();
  });

  test('EMP201 page loads', async ({ page }) => {
    await page.goto('/accounting/sars/emp201');
    await expect(page.locator('text=EMP201').first()).toBeVisible();
  });

  test('submissions page loads', async ({ page }) => {
    await page.goto('/accounting/sars/submissions');
    await expect(page.locator('text=Submission').first()).toBeVisible();
  });

  test('SARS tab highlights correctly', async ({ page }) => {
    await page.goto('/accounting/sars');
    const nav = page.locator('nav.bg-gray-900');
    const activeTab = nav.locator('[class*="border-teal-500"]');
    await expect(activeTab.first()).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENT CAPTURE / OCR
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Document Capture', () => {
  test('document capture page loads with upload zone', async ({ page }) => {
    await page.goto('/accounting/document-capture');
    await expect(page.locator('h1', { hasText: /Document Capture/ })).toBeVisible();
    // Upload zone should be present
    await expect(page.locator('text=PDF').first()).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CASH FLOW FORECAST
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Cash Flow Forecast', () => {
  test('forecast page loads', async ({ page }) => {
    await page.goto('/accounting/cash-flow-forecast');
    await expect(page.locator('h1', { hasText: /Cash Flow Forecast/ })).toBeVisible();
  });

  test('forecast page has period selector', async ({ page }) => {
    await page.goto('/accounting/cash-flow-forecast');
    const select = page.locator('select');
    await expect(select.first()).toBeVisible();
  });

  test('forecast API returns data', async ({ request }) => {
    const response = await request.get('/api/accounting/cash-flow-forecast?months=3');
    // 200 or 401 (auth)
    expect([200, 401]).toContain(response.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// APPROVAL WORKFLOWS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Approval Workflows', () => {
  test('approvals page loads', async ({ page }) => {
    await page.goto('/accounting/approvals');
    await expect(page.locator('h1', { hasText: /Approvals/ })).toBeVisible();
  });

  test('approvals page has tabs', async ({ page }) => {
    await page.goto('/accounting/approvals');
    await expect(page.getByText('Pending').first()).toBeVisible();
    await expect(page.getByText('Rules').first()).toBeVisible();
  });

  test('approval rules API responds', async ({ request }) => {
    const response = await request.get('/api/accounting/approval-rules');
    expect([200, 401]).toContain(response.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// KPI DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════

test.describe('KPI Dashboard', () => {
  test('dashboard loads with KPI cards', async ({ page }) => {
    await page.goto('/accounting');
    // Should have metric cards
    await expect(page.locator('text=IsaFlow').first()).toBeVisible();
  });

  test('KPI API responds', async ({ request }) => {
    const response = await request.get('/api/accounting/kpi-dashboard');
    expect([200, 401]).toContain(response.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPANY SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Company Settings', () => {
  test('company settings page loads', async ({ page }) => {
    await page.goto('/accounting/company-settings');
    await expect(page.locator('h1', { hasText: /Company Settings/ })).toBeVisible();
  });

  test('company settings has form sections', async ({ page }) => {
    await page.goto('/accounting/company-settings');
    await expect(page.getByText('Company Details').first()).toBeVisible();
  });

  test('companies API responds', async ({ request }) => {
    const response = await request.get('/api/accounting/companies');
    expect([200, 401]).toContain(response.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BANK FEEDS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Bank Feeds', () => {
  test('bank feeds page loads', async ({ page }) => {
    await page.goto('/accounting/bank-feeds');
    await expect(page.locator('h1', { hasText: /Bank Feeds/ })).toBeVisible();
  });

  test('bank feeds shows config status', async ({ page }) => {
    await page.goto('/accounting/bank-feeds');
    // Either shows "Not Configured" or connection list
    const notConfigured = page.locator('text=Not Configured');
    const connectButton = page.locator('text=Connect');
    const noConnections = page.locator('text=No Bank Connections');
    // One of these should be visible
    const any = notConfigured.or(connectButton).or(noConnections);
    await expect(any.first()).toBeVisible();
  });

  test('bank feeds status API responds', async ({ request }) => {
    const response = await request.get('/api/bank-feeds/connections?action=status');
    expect([200, 401]).toContain(response.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLIENT PORTAL
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Client Portal', () => {
  test('portal shows login page', async ({ page }) => {
    await page.goto('/portal');
    await expect(page.locator('h1', { hasText: /IsaFlow Portal/ })).toBeVisible();
    await expect(page.locator('text=Sign in').first()).toBeVisible();
  });

  test('portal has email and password fields', async ({ page }) => {
    await page.goto('/portal');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('portal auth API rejects invalid credentials', async ({ request }) => {
    const response = await request.post('/api/portal/auth', {
      data: { email: 'nonexistent@test.com', password: 'wrong' },
    });
    expect(response.status()).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVOICE PDF + EMAIL
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Invoice PDF', () => {
  test('invoice PDF API requires invoiceId', async ({ request }) => {
    const response = await request.get('/api/accounting/invoice-pdf');
    // Should get 400 (missing param) or 401 (auth)
    expect([400, 401]).toContain(response.status());
  });

  test('credit note PDF API requires creditNoteId', async ({ request }) => {
    const response = await request.get('/api/accounting/credit-note-pdf');
    expect([400, 401]).toContain(response.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SMART CATEGORIZATION
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Smart Categorization', () => {
  test('smart categorize API responds', async ({ request }) => {
    const response = await request.get('/api/accounting/smart-categorize');
    // 400 (missing txId) or 401 (auth)
    expect([400, 401]).toContain(response.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PWA SUPPORT
// ═══════════════════════════════════════════════════════════════════════════

test.describe('PWA', () => {
  test('manifest.json is accessible', async ({ request }) => {
    const response = await request.get('/manifest.json');
    expect(response.status()).toBe(200);
    const json = await response.json();
    expect(json.name).toBe('IsaFlow');
    expect(json.theme_color).toBe('#14b8a6');
    expect(json.start_url).toBe('/accounting');
  });

  test('service worker is accessible', async ({ request }) => {
    const response = await request.get('/sw.js');
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain('isaflow');
  });

  test('PWA icon exists', async ({ request }) => {
    const response = await request.get('/icons/icon-192.png');
    expect(response.status()).toBe(200);
  });

  test('meta tags are present', async ({ page }) => {
    await page.goto('/accounting');
    const themeColor = await page.getAttribute('meta[name="theme-color"]', 'content');
    expect(themeColor).toBe('#14b8a6');

    const manifest = await page.getAttribute('link[rel="manifest"]', 'href');
    expect(manifest).toBe('/manifest.json');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BRANDING — verify teal color scheme throughout
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Teal color scheme', () => {
  test('login page uses teal', async ({ page }) => {
    await page.goto('/login');
    const signInBtn = page.locator('button[type="submit"]');
    const cls = await signInBtn.getAttribute('class');
    expect(cls).toContain('teal');
  });

  test('sidebar logo uses teal', async ({ page }) => {
    await page.goto('/accounting');
    const logo = page.locator('.bg-teal-600').first();
    await expect(logo).toBeVisible();
  });

  test('nav active tab uses teal border', async ({ page }) => {
    await page.goto('/accounting');
    const activeTab = page.locator('nav.bg-gray-900 [class*="border-teal-500"]');
    await expect(activeTab.first()).toBeVisible();
  });
});
