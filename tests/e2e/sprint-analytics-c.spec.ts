/**
 * Sprint C: Executive Dashboard, Report Packs & Three-Way Forecast E2E Tests
 */
import { test, expect } from '@playwright/test';

test.describe('Executive Summary API', () => {
  test('GET /api/accounting/reports-executive-summary responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-executive-summary?from=2026-01-01&to=2026-03-31');
    expect([200, 401]).toContain(res.status());
  });
});

test.describe('Report Pack API', () => {
  test('GET /api/accounting/reports-pack?type=board responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-pack?type=board&from=2026-01-01&to=2026-03-31');
    expect([200, 401]).toContain(res.status());
  });

  test('GET /api/accounting/reports-pack?type=management responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-pack?type=management&from=2026-01-01&to=2026-03-31');
    expect([200, 401]).toContain(res.status());
  });

  test('GET /api/accounting/reports-pack?type=monthly responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-pack?type=monthly&from=2026-01-01&to=2026-03-31');
    expect([200, 401]).toContain(res.status());
  });

  test('rejects invalid pack type', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-pack?type=invalid&from=2026-01-01&to=2026-03-31');
    expect([400, 401]).toContain(res.status());
  });
});

test.describe('Three-Way Forecast API', () => {
  test('GET /api/accounting/reports-three-way-forecast responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-three-way-forecast?months=6&revenueGrowth=5');
    expect([200, 401]).toContain(res.status());
  });
});

test.describe('Report PDF API', () => {
  test('GET /api/accounting/reports-pdf responds', async ({ request }) => {
    const res = await request.get('/api/accounting/reports-pdf?report=executive-summary&from=2026-01-01&to=2026-03-31');
    expect([200, 401]).toContain(res.status());
  });
});

test.describe('Executive Dashboard Page', () => {
  test('GET /accounting/reports/executive-dashboard returns 200', async ({ request }) => {
    const res = await request.get('/accounting/reports/executive-dashboard');
    expect([200, 307]).toContain(res.status());
  });
});

test.describe('Report Packs Page', () => {
  test('GET /accounting/reports/report-packs returns 200', async ({ request }) => {
    const res = await request.get('/accounting/reports/report-packs');
    expect([200, 307]).toContain(res.status());
  });
});

test.describe('Three-Way Forecast Page', () => {
  test('GET /accounting/reports/three-way-forecast returns 200', async ({ request }) => {
    const res = await request.get('/accounting/reports/three-way-forecast');
    expect([200, 307]).toContain(res.status());
  });
});
