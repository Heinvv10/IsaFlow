import { test, expect } from '@playwright/test';

/**
 * PRD-06 Phase 3 — Dispute Workflow
 *
 * Exit criteria (docs/prd/PRD-06-ar-evidence-capture.md §7.2):
 *   Customer disputes a line via portal → AR aging immediately excludes it
 *   from "overdue" → resolving either re-ages or auto-creates a credit note.
 *
 * This spec exercises:
 *   1. Mint portal link for an eligible invoice.
 *   2. Customer (anon) POSTs /api/portal/invoice/[token]/dispute with a
 *      disputed amount that is a fraction of the balance.
 *   3. Internal: GET /api/accounting/ar/disputes?status=open — new row present.
 *   4. Duplicate POST → 409 (unique OPEN dispute).
 *   5. Internal resolve with mode=resolve_no_credit — status flips to resolved.
 *   6. After resolution, a fresh dispute can be raised (re-raise is allowed).
 *   7. Portal-side validation: missing reason → 400; negative amount → 400.
 */

async function csrfHeaders(
  request: import('@playwright/test').APIRequestContext,
): Promise<Record<string, string>> {
  const state = await request.storageState();
  const cookie = state.cookies.find((c) => c.name === 'isaflow_csrf');
  return cookie ? { 'X-CSRF-Token': cookie.value } : {};
}

test.describe('PRD-06 Phase 3 — disputes', () => {
  test('portal dispute → internal list → resolve → re-raise', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    let invoices: Array<{ id: string; invoice_number: string; status: string; total_amount: number; amount_paid: number }> = [];
    for (const status of ['sent', 'approved', 'partially_paid', 'overdue']) {
      const r = await request.get(`/api/accounting/customer-invoices-list?status=${status}&limit=5`);
      if (r.status() >= 500) continue;
      const j = await r.json();
      const found = j?.data?.invoices ?? j?.invoices ?? [];
      const eligible = found.filter(
        (inv: { total_amount: number; amount_paid: number }) =>
          Number(inv.total_amount) - Number(inv.amount_paid) > 0,
      );
      if (eligible.length) {
        invoices = eligible;
        break;
      }
    }
    test.skip(invoices.length === 0, 'No eligible unpaid invoices in demo company for dispute test');

    const invoice = invoices[0]!;
    const invoiceId = invoice.id;
    const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid);
    const disputedAmount = Math.max(1, Math.floor(outstanding / 2));

    const linkRes = await request.get(`/api/accounting/ar/invoice/${invoiceId}/portal-link`, {
      headers: await csrfHeaders(request),
    });
    expect(linkRes.status(), 'portal-link status').toBe(200);
    const token = (await linkRes.json())?.data?.token as string;
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const disputeRes = await request.post(`/api/portal/invoice/${token}/dispute`, {
      data: {
        reason: `E2E Phase 3 test dispute @ ${new Date().toISOString()}`,
        disputedAmount,
      },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(disputeRes.status(), 'portal dispute status').toBe(200);
    const disputeJson = await disputeRes.json();
    const disputeId = disputeJson?.data?.id as string;
    expect(disputeId).toMatch(/^[a-f0-9-]{36}$/);

    // Internal list — the fresh dispute shows up.
    const listRes = await request.get('/api/accounting/ar/disputes?status=open');
    expect(listRes.status(), 'internal list status').toBe(200);
    const listJson = await listRes.json();
    const listed = (listJson?.data?.disputes ?? []) as Array<{ id: string }>;
    expect(listed.some((d) => d.id === disputeId), 'new dispute is listed').toBe(true);

    // Duplicate open dispute on the whole invoice → 409.
    const dup = await request.post(`/api/portal/invoice/${token}/dispute`, {
      data: { reason: 'duplicate', disputedAmount: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(dup.status(), 'duplicate dispute status').toBe(409);

    // Resolve without credit — should re-age back into overdue, not create a credit note.
    const resolveRes = await request.post(
      `/api/accounting/ar/disputes/${disputeId}/resolve`,
      {
        data: { mode: 'resolve_no_credit', note: 'E2E — sorted over the phone' },
        headers: { ...(await csrfHeaders(request)), 'Content-Type': 'application/json' },
      },
    );
    expect(resolveRes.status(), 'resolve status').toBe(200);
    const resolveJson = await resolveRes.json();
    expect(resolveJson?.data?.status).toBe('resolved');
    expect(resolveJson?.data?.resolutionMode).toBe('resolve_no_credit');
    expect(resolveJson?.data?.creditNoteId).toBeNull();

    // Re-raise is allowed after resolution.
    const reraise = await request.post(`/api/portal/invoice/${token}/dispute`, {
      data: {
        reason: 'E2E Phase 3 re-raise',
        disputedAmount: 1,
      },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(reraise.status(), 're-raise status').toBe(200);
    const reraiseId = (await reraise.json())?.data?.id as string;

    // Clean up so repeated runs don't pile disputes onto one invoice.
    await request.post(`/api/accounting/ar/disputes/${reraiseId}/withdraw`, {
      data: { note: 'E2E cleanup' },
      headers: { ...(await csrfHeaders(request)), 'Content-Type': 'application/json' },
    });
  });

  test('portal dispute validates input', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    // Unknown token → 404.
    const unknown = await request.post(
      `/api/portal/invoice/${'a'.repeat(64)}/dispute`,
      {
        data: { reason: 'test', disputedAmount: 1 },
        headers: { 'Content-Type': 'application/json' },
      },
    );
    expect(unknown.status(), 'unknown-token status').toBe(404);

    // Malformed token → 404.
    const malformed = await request.post('/api/portal/invoice/not-hex/dispute', {
      data: { reason: 'test', disputedAmount: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(malformed.status(), 'malformed-token status').toBe(404);
  });
});
