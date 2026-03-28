import { test, expect } from '@playwright/test';

const ASSET_ROUTES = ['/accounting/assets', '/accounting/assets/new', '/accounting/assets/categories', '/accounting/assets/disposals', '/accounting/assets/register'];

test.describe('Asset page routes load', () => {
  for (const route of ASSET_ROUTES) {
    test(`GET ${route} returns 200 or 307`, async ({ page }) => {
      const response = await page.goto(route);
      expect([200, 307]).toContain(response?.status() ?? 0);
    });
  }
});

const ASSET_API_ROUTES = ['/api/accounting/assets', '/api/accounting/assets-categories', '/api/accounting/assets-disposals', '/api/accounting/assets-register', '/api/accounting/assets-depreciation-schedule'];

test.describe('Asset API routes respond', () => {
  for (const route of ASSET_API_ROUTES) {
    test(`GET ${route} does not 404`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).not.toBe(404);
    });
  }
});

test.describe('Asset List Page', () => {
  test('shows correct heading', async ({ page }) => {
    await page.goto('/accounting/assets');
    await expect(page.locator('h1', { hasText: /Fixed Assets|Asset Register/ })).toBeVisible();
  });
  test('has Add Asset button', async ({ page }) => {
    await page.goto('/accounting/assets');
    await expect(page.locator('a, button').filter({ hasText: /Add Asset|New Asset/ }).first()).toBeVisible();
  });
  test('displays asset table with correct columns', async ({ page }) => {
    await page.goto('/accounting/assets');
    for (const h of ['Asset', 'Name', 'Category', 'Cost', 'Book Value', 'Status']) {
      await expect(page.locator('th', { hasText: h }).first()).toBeVisible();
    }
  });
  test('has category filter', async ({ page }) => {
    await page.goto('/accounting/assets');
    await expect(page.locator('select').first()).toBeVisible();
  });
  test('has export button', async ({ page }) => {
    await page.goto('/accounting/assets');
    await expect(page.locator('button', { hasText: /Export|CSV/ }).first()).toBeVisible();
  });
});

test.describe('New Asset Form', () => {
  test('shows correct heading', async ({ page }) => {
    await page.goto('/accounting/assets/new');
    await expect(page.locator('h1', { hasText: /New Asset|Add Asset/ })).toBeVisible();
  });
  test('has required form fields', async ({ page }) => {
    await page.goto('/accounting/assets/new');
    await expect(page.locator('label', { hasText: /Name/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Category/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Purchase Date/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Cost|Purchase Price/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Salvage|Residual/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Useful Life/i }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: /Depreciation Method/i }).first()).toBeVisible();
  });
  test('shows Straight-Line option', async ({ page }) => {
    await page.goto('/accounting/assets/new');
    await expect(page.getByText(/Straight.Line/i).first()).toBeVisible();
  });
  test('shows SARS category selector', async ({ page }) => {
    await page.goto('/accounting/assets/new');
    await expect(page.getByText(/SARS|Wear.and.Tear/i).first()).toBeVisible();
  });
  test('has save button', async ({ page }) => {
    await page.goto('/accounting/assets/new');
    await expect(page.locator('button', { hasText: /Save|Create/i }).first()).toBeVisible();
  });
});

test.describe('Asset Categories Page', () => {
  test('shows SARS categories', async ({ page }) => {
    await page.goto('/accounting/assets/categories');
    await expect(page.locator('h1', { hasText: /Asset Categories|SARS/i })).toBeVisible();
  });
  test('displays standard categories', async ({ page }) => {
    await page.goto('/accounting/assets/categories');
    for (const cat of ['Computers', 'Motor Vehicles', 'Furniture', 'Office Equipment']) {
      await expect(page.getByText(cat).first()).toBeVisible();
    }
  });
  test('shows depreciation rates', async ({ page }) => {
    await page.goto('/accounting/assets/categories');
    await expect(page.getByText(/33\.33%|33%/).first()).toBeVisible();
  });
});

test.describe('Asset Register Report', () => {
  test('shows heading', async ({ page }) => {
    await page.goto('/accounting/assets/register');
    await expect(page.locator('h1', { hasText: /Asset Register/i })).toBeVisible();
  });
  test('has date filter', async ({ page }) => {
    await page.goto('/accounting/assets/register');
    expect(await page.locator('input[type="date"]').count()).toBeGreaterThanOrEqual(1);
  });
  test('has export button', async ({ page }) => {
    await page.goto('/accounting/assets/register');
    await expect(page.locator('button', { hasText: /Export|CSV|PDF/ }).first()).toBeVisible();
  });
  test('shows summary totals', async ({ page }) => {
    await page.goto('/accounting/assets/register');
    await expect(page.getByText(/Total Cost|Total Assets/i).first()).toBeVisible();
  });
});

test.describe('Asset Disposals Page', () => {
  test('shows heading', async ({ page }) => {
    await page.goto('/accounting/assets/disposals');
    await expect(page.locator('h1', { hasText: /Disposal|Disposed/i })).toBeVisible();
  });
  test('shows disposal methods', async ({ page }) => {
    await page.goto('/accounting/assets/disposals');
    await expect(page.getByText(/Sale|Scrap|Write.Off/i).first()).toBeVisible();
  });
});

test.describe('Asset Navigation Integration', () => {
  test('Accountant\'s Area dropdown contains Assets link', async ({ page }) => {
    await page.goto('/accounting');
    const nav = page.locator('nav.bg-gray-900');
    await nav.getByRole('button', { name: "Accountant's Area", exact: true }).click();
    const dropdown = nav.locator('.absolute');
    await expect(dropdown.first()).toBeVisible();
    await expect(dropdown.getByText(/Assets|Fixed Assets/).first()).toBeVisible();
  });
});

test.describe('Asset API CRUD', () => {
  test('GET /api/accounting/assets returns list', async ({ request }) => {
    const r = await request.get('/api/accounting/assets');
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) { const j = await r.json(); expect(j.success).toBe(true); expect(Array.isArray(j.data)).toBe(true); }
  });
  test('POST /api/accounting/assets validates required fields', async ({ request }) => {
    const r = await request.post('/api/accounting/assets', { data: {} });
    expect([400, 401, 422]).toContain(r.status());
  });
  test('GET /api/accounting/assets-categories returns categories', async ({ request }) => {
    const r = await request.get('/api/accounting/assets-categories');
    expect([200, 401]).toContain(r.status());
    if (r.status() === 200) { const j = await r.json(); expect(j.success).toBe(true); }
  });
});
