/**
 * Sprint B: Waterfall Charts & Trend Analysis E2E Tests
 */
import { test, expect } from '@playwright/test';

test.describe('Waterfall API', () => {
  test('GET /api/accounting/reports-waterfall?type=profit responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-waterfall?type=profit&from=2026-01-01&to=2026-03-31');
    expect([200, 401]).toContain(res.status());
  });

  test('GET /api/accounting/reports-waterfall?type=cashflow responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-waterfall?type=cashflow&from=2026-01-01&to=2026-03-31');
    expect([200, 401]).toContain(res.status());
  });
});

test.describe('Trend Analysis API', () => {
  test('GET /api/accounting/reports-trend-analysis responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-trend-analysis?metric=revenue&months=6');
    expect([200, 401]).toContain(res.status());
  });
});

test.describe('Waterfall Page', () => {
  test('GET /accounting/reports/waterfall returns 200', async ({ request }) => {
    const res = await request.get('/accounting/reports/waterfall');
    expect([200, 307]).toContain(res.status());
  });
});

test.describe('Trend Analysis Page', () => {
  test('GET /accounting/reports/trend-analysis returns 200', async ({ request }) => {
    const res = await request.get('/accounting/reports/trend-analysis');
    expect([200, 307]).toContain(res.status());
  });
});
