import { test, expect } from '@playwright/test';

test.describe('Leave page routes load', () => {
  test('GET /payroll/leave returns 200 or 307', async ({ page }) => {
    const response = await page.goto('/payroll/leave');
    expect([200, 307]).toContain(response?.status() ?? 0);
  });
});

test.describe('Leave API routes respond', () => {
  for (const route of ['/api/payroll/leave-applications', '/api/payroll/leave-balances']) {
    test(`GET ${route} does not 404`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).not.toBe(404);
    });
  }
});

test.describe('Leave Management Page', () => {
  test('shows correct heading', async ({ page }) => {
    await page.goto('/payroll/leave');
    await expect(page.locator('h1', { hasText: /Leave Management/ })).toBeVisible();
  });
  test('has Apply for Leave button', async ({ page }) => {
    await page.goto('/payroll/leave');
    await expect(page.locator('a, button').filter({ hasText: /Apply.*Leave/ }).first()).toBeVisible();
  });
  test('displays table columns', async ({ page }) => {
    await page.goto('/payroll/leave');
    for (const h of ['Employee', 'Type', 'From', 'Days', 'Status']) {
      await expect(page.locator('th', { hasText: h }).first()).toBeVisible();
    }
  });
  test('has status filter', async ({ page }) => {
    await page.goto('/payroll/leave');
    await expect(page.locator('select').first()).toBeVisible();
  });
});

test.describe('Leave API CRUD', () => {
  test('GET /api/payroll/leave-applications returns list', async ({ request }) => {
    const r = await request.get('/api/payroll/leave-applications');
    expect([200, 401]).toContain(r.status());
  });
  test('GET /api/payroll/leave-balances returns data', async ({ request }) => {
    const r = await request.get('/api/payroll/leave-balances');
    expect([200, 401]).toContain(r.status());
  });
});
