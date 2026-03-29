/**
 * Sprint A: Financial Analysis E2E Tests
 */
import { test, expect } from '@playwright/test';

test.describe('Extended Ratios API', () => {
  test('GET /api/accounting/reports-extended-ratios responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-extended-ratios?from=2026-01-01&to=2026-03-31');
    expect([200, 401]).toContain(res.status());
  });
});

test.describe('Ratio Trends API', () => {
  test('GET /api/accounting/reports-ratio-trends responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-ratio-trends?months=6');
    expect([200, 401]).toContain(res.status());
  });
});

test.describe('KPI Scorecard API', () => {
  test('GET /api/accounting/reports-kpi-scorecard responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-kpi-scorecard?from=2026-01-01&to=2026-03-31');
    expect([200, 401]).toContain(res.status());
  });
});

test.describe('Financial Analysis Page', () => {
  test('GET /accounting/reports/financial-analysis returns 200', async ({ request }) => {
    const res = await request.get('/accounting/reports/financial-analysis');
    expect([200, 307]).toContain(res.status());
  });
});
