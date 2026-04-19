/**
 * PRD-03 — Loan amortisation golden-path smoke test.
 *
 * Validates the full create → event → schedule → compliance → close
 * round-trip using the REST API (auth piggybacks on the session
 * cookie from auth.setup.ts), with a final UI render check to prove
 * the detail page wires up against the DB.
 *
 * Form-filling is covered by unit tests at the service layer; the
 * E2E is here to prove the HTTP routes + auth + DB + UI stitch
 * together, not to retest validation logic.
 *
 * Run with:
 *   bunx playwright test tests/e2e/loans-smoke.spec.ts --config playwright-test.config.ts
 */
import { test, expect } from '@playwright/test';

const SUFFIX = String(Date.now()).slice(-6);
const LOAN_REF = `BND-${SUFFIX}`;

test.describe('PRD-03 — loan amortisation golden path', () => {
  test('create loan → add lump → preview schedule → assess compliance → close period', async ({ page }) => {
    // ── 1. Find a system rate curve (SA Prime, seeded by migration 393) ──
    const curvesRes = await page.request.get('/api/accounting/loan-rate-curves');
    expect(curvesRes.status()).toBe(200);
    const curvesBody = await curvesRes.json();
    const saPrime = curvesBody.data.find((c: { name: string; isSystem: boolean }) =>
      c.isSystem && /prime/i.test(c.name),
    );
    expect(saPrime, 'SA Prime system curve should be seeded').toBeTruthy();

    // ── 2. Create a loan ────────────────────────────────────────────────
    const createRes = await page.request.post('/api/accounting/loans', {
      data: {
        reference: LOAN_REF,
        product: 'bond',
        principal: 224_873.49,
        startDate: '2026-03-15',
        termMonths: 72,
        rateMode: 'PRIME_PLUS',
        margin: 4,
        residual: 0,
        curveId: saPrime.id,
        recurringSkipMonths: [12, 1],
        repriceMode: 'RESOLVE_ON_RATE_CHANGE',
        skipMode: 'MAINTAIN_TERM',
        lumpMode: 'REDUCE_INSTALLMENT',
      },
    });
    expect(createRes.status()).toBe(201);
    const createBody = await createRes.json();
    const loanId: string = createBody.data.id;
    expect(loanId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createBody.data.reference).toBe(LOAN_REF);
    expect(createBody.data.principal).toBe(224_873.49);

    // ── 3. Add a lump event (R50 000 on 2026-06-15) ───────────────────
    const eventRes = await page.request.post(`/api/accounting/loans/${loanId}/events`, {
      data: { kind: 'LUMP', date: '2026-06-15', amount: 50_000, note: 'E2E smoke lump' },
    });
    expect(eventRes.status()).toBe(201);

    // ── 4. Preview schedule (dry-run, no persist) ──────────────────────
    const previewRes = await page.request.post(`/api/accounting/loans/${loanId}/schedule`, {
      data: {},  // no override — use the persisted events
    });
    expect(previewRes.status()).toBe(200);
    const previewBody = await previewRes.json();
    const rows = previewBody.data.rows;
    expect(rows.length).toBeGreaterThan(0);

    // The June row should have the lump applied
    const juneRow = rows.find((r: { date: string }) => r.date === '2026-06-15');
    expect(juneRow, '2026-06-15 row should exist').toBeTruthy();
    expect(juneRow.lump).toBeCloseTo(50_000, 2);

    // Σ(payment + lump) − Σinterest ≈ principal (engine invariant)
    const sumPay = rows.reduce((s: number, r: { payment: number }) => s + r.payment, 0);
    const sumLump = rows.reduce((s: number, r: { lump: number }) => s + r.lump, 0);
    const sumInt = rows.reduce((s: number, r: { interest: number }) => s + r.interest, 0);
    expect(Math.abs(sumPay + sumLump - sumInt - 224_873.49)).toBeLessThan(1.0);

    // ── 5. Persist schedule (get-or-compute with caching) ─────────────
    const scheduleRes = await page.request.get(`/api/accounting/loans/${loanId}/schedule`);
    expect(scheduleRes.status()).toBe(200);
    const scheduleBody = await scheduleRes.json();
    expect(scheduleBody.data.rows.length).toBeGreaterThan(0);

    // ── 6. Run compliance assessment ───────────────────────────────────
    const complianceRes = await page.request.post(`/api/accounting/loans/${loanId}/compliance`, {
      data: { asOfDate: '2026-04-19' },
    });
    expect(complianceRes.status()).toBe(201);
    const complianceBody = await complianceRes.json();
    expect([1, 2, 3]).toContain(complianceBody.data.stage);
    expect(complianceBody.data.ncaFlagged).toBe(false);  // healthy loan
    expect(complianceBody.data.eclAmount).toBeGreaterThanOrEqual(0);

    // ── 7. Close the loan period (reclass journals skipped without GL accts) ──
    const closeRes = await page.request.post('/api/accounting/loan-periods/202604/close');
    expect(closeRes.status()).toBe(201);
    const closeBody = await closeRes.json();
    expect(closeBody.data.locked).toBe(true);
    expect(closeBody.data.yyyymm).toBe('202604');
    // This loan has no GL accounts → should land in skippedLoans
    expect(closeBody.data.skippedLoans).toBeDefined();

    // ── 8. Idempotency: re-closing must reject ────────────────────────
    const dupCloseRes = await page.request.post('/api/accounting/loan-periods/202604/close');
    expect(dupCloseRes.status()).toBeGreaterThanOrEqual(400);

    // ── 9. UI render check — loan detail page loads with correct reference ──
    await page.goto(`/accounting/loans/${loanId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(LOAN_REF).first()).toBeVisible({ timeout: 10_000 });

    // Schedule tab renders at least one row
    await page.getByRole('button', { name: /^schedule$/i }).click();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/2026-04-15|April.*2026/).first()).toBeVisible({ timeout: 10_000 });
  });
});
