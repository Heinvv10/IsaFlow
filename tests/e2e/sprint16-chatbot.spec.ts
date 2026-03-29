import { test, expect } from '@playwright/test';

test.describe('Portal Chatbot API', () => {
  test('POST /api/portal/chat does not 404', async ({ request }) => {
    const r = await request.post('/api/portal/chat', { data: {} });
    expect(r.status()).not.toBe(404);
  });
  test('validates question required', async ({ request }) => {
    const r = await request.post('/api/portal/chat', { data: { clientId: 'x' } });
    expect(r.status()).toBe(400);
  });
  test('validates clientId required', async ({ request }) => {
    const r = await request.post('/api/portal/chat', { data: { question: 'Hi' } });
    expect(r.status()).toBe(400);
  });
});
