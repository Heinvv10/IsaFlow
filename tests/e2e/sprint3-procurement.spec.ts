import { test, expect } from '@playwright/test';

const PO_ROUTES = ['/accounting/purchase-orders', '/accounting/purchase-orders/new'];

test.describe('PO page routes load', () => {
  for (const route of PO_ROUTES) {
    test(`GET ${route} returns 200 or 307`, async ({ page }) => {
      const response = await page.goto(route);
      expect([200, 307]).toContain(response?.status() ?? 0);
    });
  }
});

const PO_API_ROUTES = ['/api/accounting/purchase-orders', '/api/accounting/goods-received'];

test.describe('Procurement API routes respond', () => {
  for (const route of PO_API_ROUTES) {
    test(`GET ${route} does not 404`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).not.toBe(404);
    });
  }
});

test.describe('Purchase Orders List Page', () => {
  test('shows correct heading', async ({ page }) => {
    await page.goto('/accounting/purchase-orders');
    await expect(page.locator('h1', { hasText: /Purchase Orders/ })).toBeVisible();
  });
  test('has New PO button', async ({ page }) => {
    await page.goto('/accounting/purchase-orders');
    await expect(page.locator('a, button').filter({ hasText: /New PO|Add.*Order/ }).first()).toBeVisible();
  });
  test('displays PO table columns', async ({ page }) => {
    await page.goto('/accounting/purchase-orders');
    for (const h of ['PO', 'Supplier', 'Date', 'Total', 'Status']) {
      await expect(page.locator('th', { hasText: h }).first()).toBeVisible();
    }
  });
  test('has status filter', async ({ page }) => {
    await page.goto('/accounting/purchase-orders');
    await expect(page.locator('select').first()).toBeVisible();
  });
  test('shows summary cards', async ({ page }) => {
    await page.goto('/accounting/purchase-orders');
    await expect(page.getByText(/Total Orders/i).first()).toBeVisible();
    await expect(page.getByText(/Total Value/i).first()).toBeVisible();
  });
});

test.describe('New Purchase Order Form', () => {
  test('shows heading', async ({ page }) => {
    await page.goto('/accounting/purchase-orders/new');
    await expect(page.locator('h1', { hasText: /New Purchase Order/ })).toBeVisible();
  });
  test('has supplier selector', async ({ page }) => {
    await page.goto('/accounting/purchase-orders/new');
    await expect(page.locator('label', { hasText: /Supplier/i }).first()).toBeVisible();
  });
  test('has line items section', async ({ page }) => {
    await page.goto('/accounting/purchase-orders/new');
    await expect(page.locator('h2', { hasText: /Line Items/i }).first()).toBeVisible();
  });
  test('shows totals section', async ({ page }) => {
    await page.goto('/accounting/purchase-orders/new');
    // The form shows subtotal, VAT, and total calculations
    await expect(page.locator('text=Subtotal').first()).toBeVisible();
  });
  test('has save button', async ({ page }) => {
    await page.goto('/accounting/purchase-orders/new');
    await expect(page.locator('button', { hasText: /Create|Save/i }).first()).toBeVisible();
  });
});

test.describe('Procurement API CRUD', () => {
  test('GET /api/accounting/purchase-orders returns list', async ({ request }) => {
    const r = await request.get('/api/accounting/purchase-orders');
    expect([200, 401]).toContain(r.status());
  });
  test('POST /api/accounting/purchase-orders validates', async ({ request }) => {
    const r = await request.post('/api/accounting/purchase-orders', { data: {} });
    expect([400, 401, 422]).toContain(r.status());
  });
  test('GET /api/accounting/goods-received returns list', async ({ request }) => {
    const r = await request.get('/api/accounting/goods-received');
    expect([200, 401]).toContain(r.status());
  });
});
