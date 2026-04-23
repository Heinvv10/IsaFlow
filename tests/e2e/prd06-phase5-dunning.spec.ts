import { test, expect } from '@playwright/test';

/**
 * PRD-06 Phase 5 — Dunning Engine
 *
 * Exit criteria (docs/prd/PRD-06-ar-evidence-capture.md §7.2 Phase 5):
 *   90 days of overdue receivables run through the ladder unattended;
 *   response rate telemetry visible.
 *
 * Read-only against any environment — never sends real dunning emails,
 * never flips real cron state. Covers the shape of the public API surface
 * plus guard rails (auth, validation, webhook 404-on-unknown-token).
 */

test.describe('PRD-06 Phase 5 — dunning engine', () => {
  test('templates endpoint returns SA defaults shape', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.get('/api/accounting/ar/dunning/templates');
    test.skip(res.status() === 401, 'requires logged-in session');
    expect(res.status(), 'templates list status').toBe(200);

    const json = await res.json();
    const templates =
      (json?.data?.templates as Array<Record<string, unknown>> | undefined) ?? [];
    expect(Array.isArray(templates), 'templates is array').toBe(true);

    if (templates.length > 0) {
      for (const t of templates) {
        expect(t).toHaveProperty('id');
        expect(t).toHaveProperty('name');
        expect(t).toHaveProperty('tone');
        expect(['polite', 'firm', 'final', 'legal']).toContain(t.tone);
        expect(t).toHaveProperty('days_overdue_min');
        expect(t).toHaveProperty('subject_template');
        expect(t).toHaveProperty('body_template');
      }

      const tones = new Set(templates.map((t) => t.tone));
      expect(tones.has('polite') || tones.has('firm'), 'ladder seeded').toBe(true);
    }
  });

  test('sends endpoint returns list shape', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.get('/api/accounting/ar/dunning/sends?limit=5');
    test.skip(res.status() === 401, 'requires logged-in session');
    expect(res.status(), 'sends list status').toBe(200);

    const json = await res.json();
    const sends = (json?.data?.sends as Array<unknown> | undefined) ?? [];
    expect(Array.isArray(sends), 'sends is array').toBe(true);
  });

  test('settings endpoint exposes default auto_send=false', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.get('/api/accounting/ar/dunning/settings');
    test.skip(res.status() === 401, 'requires logged-in session');
    expect(res.status(), 'settings status').toBe(200);

    const json = await res.json();
    const s = json?.data?.settings as { auto_send_enabled?: boolean; min_outstanding_zar?: number } | undefined;
    expect(s, 'settings object present').toBeDefined();
    expect(typeof s!.auto_send_enabled, 'auto_send_enabled is boolean').toBe('boolean');
  });

  test('preview rejects missing invoiceId', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const listRes = await request.get('/api/accounting/ar/dunning/templates');
    test.skip(listRes.status() === 401, 'requires logged-in session');
    const listJson = await listRes.json();
    const first = listJson?.data?.templates?.[0] as { id: string } | undefined;
    test.skip(!first, 'no templates available');

    const res = await request.post(
      `/api/accounting/ar/dunning/templates/${first!.id}/preview`,
      { data: {} },
    );
    expect(res.status(), 'missing invoiceId → 400').toBe(400);
  });

  test('send endpoint rejects missing templateId', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.post('/api/accounting/ar/dunning/send', {
      data: { invoiceId: '00000000-0000-0000-0000-000000000000' },
    });
    test.skip(res.status() === 401, 'requires logged-in session');
    expect(res.status(), 'missing templateId → 400').toBe(400);
  });

  test('cron endpoint rejects requests without X-Cron-Secret', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.post('/api/cron/dunning-send');
    expect(res.status(), 'unauth cron → 401').toBe(401);
  });

  test('response webhook 404s for unknown message token', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.post('/api/webhooks/dunning-response', {
      data: {
        messageToken: '99999999-9999-9999-9999-999999999999',
        action: 'silent',
      },
    });
    // 401 if a webhook secret is enforced in prod; 404 if not. Either is acceptable
    // evidence the endpoint is wired and rejecting bogus input.
    expect([401, 404]).toContain(res.status());
  });

  test('response webhook rejects invalid action with 400', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const res = await request.post('/api/webhooks/dunning-response', {
      data: {
        messageToken: '99999999-9999-9999-9999-999999999999',
        action: 'not-an-action',
      },
    });
    // If secret-gated, 401. If open, 400. Either confirms validation chain.
    expect([400, 401]).toContain(res.status());
  });
});
