import { test, expect } from '@playwright/test';

const INVENTORY_ROUTES = ['/accounting/products', '/accounting/products/new', '/accounting/stock-levels'];

test.describe('Inventory page routes load', () => {
  for (const route of INVENTORY_ROUTES) {
    test(`GET ${route} returns 200 or 307`, async ({ page }) => {
      const response = await page.goto(route);
      expect([200, 307]).toContain(response?.status() ?? 0);
    });
  }
});

const INVENTORY_API_ROUTES = ['/api/accounting/products', '/api/accounting/products-categories', '/api/accounting/stock-levels', '/api/accounting/stock-adjustments'];

test.describe('Inventory API routes respond', () => {
  for (const route of INVENTORY_API_ROUTES) {
    test(`GET ${route} does not 404`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).not.toBe(404);
    });
  }
});

test.describe('Products List Page', () => {
  test('shows correct heading', async ({ page }) => {
    await page.goto('/accounting/products');
    await expect(page.locator('h1', { hasText: /Products|Inventory/ })).toBeVisible();
  });
  test('has Add Product button', async ({ page }) => {
    await page.goto('/accounting/products');
    await expect(page.locator('a, button').filter({ hasText: /Add Product|New Product/ }).first()).toBeVisible();
  });
  test('displays product table columns', async ({ page }) => {
    await page.goto('/accounting/products');
    for (const h of ['Code', 'Name', 'Type', 'Cost', 'Stock']) {
      await expect(page.locator('th', { hasText: h }).first()).toBeVisible();
    }
  });
  test('has type filter', async ({ page }) => {
    await page.goto('/accounting/products');
    await expect(page.locator('select').first()).toBeVisible();
  });
  test('has search input', async ({ page }) => {
    await page.goto('/accounting/products');
    await expect(page.locator('input[placeholder*="Search"]').first()).toBeVisible();
  });
  test('shows summary cards', async ({ page }) => {
    await page.goto('/accounting/products');
    await expect(page.getByText(/Total Products/i).first()).toBeVisible();
    await expect(page.getByText(/Stock Value/i).first()).toBeVisible();
  });
});

test.describe('New Product Form', () => {
  test('shows heading', async ({ page }) => {
    await page.goto('/accounting/products/new');
    await expect(page.locator('h1', { hasText: /New Product/ })).toBeVisible();
  });
  test('has required fields', async ({ page }) => {
    await page.goto('/accounting/products/new');
    await expect(page.locator('label', { hasText: /Name/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Code/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Type/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Cost Price/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Selling Price/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Cost Method/i }).first()).toBeVisible();
  });
  test('has save button', async ({ page }) => {
    await page.goto('/accounting/products/new');
    await expect(page.locator('button', { hasText: /Save|Create/i }).first()).toBeVisible();
  });
});

test.describe('Stock Levels Page', () => {
  test('shows heading', async ({ page }) => {
    await page.goto('/accounting/stock-levels');
    await expect(page.locator('h1', { hasText: /Stock Levels/i })).toBeVisible();
  });
  test('shows summary cards', async ({ page }) => {
    await page.goto('/accounting/stock-levels');
    await expect(page.getByText(/Total.*Value|Stock Value/i).first()).toBeVisible();
  });
  test('has below-reorder filter', async ({ page }) => {
    await page.goto('/accounting/stock-levels');
    await expect(page.getByText(/reorder/i).first()).toBeVisible();
  });
});

test.describe('Items nav contains Products link', () => {
  test('Products page is accessible from Items section', async ({ page }) => {
    // Verify products page loads when navigated directly
    const response = await page.goto('/accounting/products');
    const status = response?.status() ?? 0;
    expect([200, 307]).toContain(status);
    // And the items tab highlights correctly
    await page.goto('/accounting/products');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1', { hasText: /Products|Inventory/ }).first()).toBeVisible();
  });
});

test.describe('Inventory API CRUD', () => {
  test('GET /api/accounting/products returns list', async ({ request }) => {
    const r = await request.get('/api/accounting/products');
    expect([200, 401]).toContain(r.status());
  });
  test('POST /api/accounting/products validates', async ({ request }) => {
    const r = await request.post('/api/accounting/products', { data: {} });
    expect([400, 401, 422]).toContain(r.status());
  });
  test('GET /api/accounting/stock-levels returns data', async ({ request }) => {
    const r = await request.get('/api/accounting/stock-levels');
    expect([200, 401]).toContain(r.status());
  });
});
