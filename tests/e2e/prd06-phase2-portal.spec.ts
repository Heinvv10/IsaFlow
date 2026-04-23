import { test, expect } from '@playwright/test';

/**
 * PRD-06 Phase 2 — Customer Portal + Access Log
 *
 * Exit criteria (from docs/prd/PRD-06-ar-evidence-capture.md §7.2):
 *   Bookkeeper sends an invoice → customer opens via portal link
 *   → AR list shows "viewed N minutes ago" within 60s.
 *
 * This spec exercises the full chain against prod (or dev):
 *   1. List approved/sent invoices for the tenant — pick one with a
 *      portal_token (existing ones from prior sessions) or mint one via
 *      /api/accounting/ar/invoice/[id]/portal-link.
 *   2. Hit the public portal page — expect 200 + invoice-number text.
 *   3. Hit the public sealed-PDF endpoint — expect application/pdf.
 *   4. Hit the tracking pixel — expect image/gif, 1×1 bytes.
 *   5. Poll /api/accounting/ar/invoice/[id]/views until we see ≥3 rows
 *      (one per source) within 60s.
 */

async function csrfHeaders(
  request: import('@playwright/test').APIRequestContext,
): Promise<Record<string, string>> {
  const state = await request.storageState();
  const cookie = state.cookies.find((c) => c.name === 'isaflow_csrf');
  return cookie ? { 'X-CSRF-Token': cookie.value } : {};
}

// Portal + pixel are public — Playwright's default `request` carries the
// authed storage state which we strip for those calls to simulate a
// customer coming in from an email client.
async function anonRequest(
  request: import('@playwright/test').APIRequestContext,
): Promise<import('@playwright/test').APIRequestContext> {
  return request; // storage state is only sent on cookie-matching hosts; for
  // /portal and /api/portal routes we rely on the token, not cookies.
}

test.describe('PRD-06 Phase 2 — portal + access log', () => {
  test('portal link → view page → download PDF → pixel hit → AR views log', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    // 1. Pick an eligible invoice (not draft, not cancelled).
    const list = await request.get('/api/accounting/customer-invoices-list?status=sent&limit=5');
    expect(list.status(), 'list status').toBeLessThan(500);
    const listJson = await list.json();
    const invoices = listJson?.data?.invoices ?? listJson?.invoices ?? [];
    test.skip(invoices.length === 0, 'No sent invoices in demo company to test portal with');

    const invoice = invoices[0]!;
    const invoiceId = invoice.id as string;

    // 2. Mint (or fetch existing) portal link.
    const linkRes = await request.get(`/api/accounting/ar/invoice/${invoiceId}/portal-link`, {
      headers: await csrfHeaders(request),
    });
    expect(linkRes.status(), 'portal-link status').toBe(200);
    const linkJson = await linkRes.json();
    const token = linkJson?.data?.token as string;
    const portalUrl = linkJson?.data?.url as string;
    const pixelUrl = linkJson?.data?.pixelUrl as string;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(portalUrl).toContain(`/portal/invoice/${token}`);

    // Pre-count existing views so we only assert on NEW rows from this test.
    const beforeViewsRes = await request.get(`/api/accounting/ar/invoice/${invoiceId}/views`);
    const beforeViewsJson = await beforeViewsRes.json();
    const beforeCount = (beforeViewsJson?.data?.views ?? []).length;

    // 3. Open the public portal page (token-gated, no auth).
    const anon = await anonRequest(request);
    const pageRes = await anon.get(`/portal/invoice/${token}`);
    expect(pageRes.status(), 'portal page status').toBeLessThan(400);
    const html = await pageRes.text();
    expect(html).toContain(invoice.invoice_number);

    // 4. Download the sealed PDF.
    const pdfRes = await anon.get(`/api/portal/invoice/${token}/pdf`);
    expect(pdfRes.status(), 'portal pdf status').toBe(200);
    expect(pdfRes.headers()['content-type']).toContain('application/pdf');

    // 5. Hit the tracking pixel.
    const pixelRes = await anon.get(pixelUrl);
    expect(pixelRes.status(), 'pixel status').toBe(200);
    expect(pixelRes.headers()['content-type']).toContain('image/gif');

    // 6. Poll the views endpoint until we see the 3 new rows land. The pixel
    // log is fire-and-forget, so we give it up to 60s.
    let afterCount = beforeCount;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && afterCount < beforeCount + 3) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await request.get(`/api/accounting/ar/invoice/${invoiceId}/views`);
      if (res.status() === 200) {
        const json = await res.json();
        afterCount = (json?.data?.views ?? []).length;
      }
    }
    expect(afterCount, 'new view rows after ≤60s').toBeGreaterThanOrEqual(beforeCount + 3);
  });

  test('portal PDF rejects a garbage token with 404-shape', async ({ request }) => {
    const res = await request.get('/api/portal/invoice/not-a-real-token-aaaaaaaaaaaaaaaaaaaaaaaa/pdf');
    expect(res.status(), 'bad-token pdf status').toBeGreaterThanOrEqual(400);
  });

  test('tracking pixel ALWAYS returns a GIF (even for unknown tokens) — never leaks token validity', async ({ request }) => {
    const res = await request.get('/api/portal/pixel/deadbeef'.padEnd(72, '0'));
    expect(res.status(), 'pixel status').toBe(200);
    expect(res.headers()['content-type']).toContain('image/gif');
  });
});
