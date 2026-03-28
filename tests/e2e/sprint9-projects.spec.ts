import { test, expect } from '@playwright/test';

test.describe('Project API routes', () => {
  for (const route of ['/api/accounting/projects', '/api/accounting/project-time-entries']) {
    test(`GET ${route} does not 404`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).not.toBe(404);
    });
  }
});

test.describe('Projects API CRUD', () => {
  test('GET returns list', async ({ request }) => {
    const r = await request.get('/api/accounting/projects');
    expect([200, 401]).toContain(r.status());
  });
  test('POST validates', async ({ request }) => {
    const r = await request.post('/api/accounting/projects', { data: {} });
    expect([400, 401, 422]).toContain(r.status());
  });
});

test.describe('Time Entries API', () => {
  test('GET returns list', async ({ request }) => {
    const r = await request.get('/api/accounting/project-time-entries');
    expect([200, 401]).toContain(r.status());
  });
  test('POST validates', async ({ request }) => {
    const r = await request.post('/api/accounting/project-time-entries', { data: {} });
    expect([400, 401, 422]).toContain(r.status());
  });
});
