/**
 * P4.2 exceptions-gate E2E — the differentiator.
 *
 * Drives the REAL /accounting/sars/vat201 page with a real authenticated
 * session (golden storageState), route-mocking only the SARS endpoints so the
 * two gate signals are deterministic:
 *   - efiling-status -> configured:true  (arms the "Submit to SARS" surface)
 *   - vat-exceptions -> dirty vs clean   (drives the gate both ways)
 *
 * Proves: when pre-filing exceptions exist, a "do not file" banner blocks the
 * submit button; when the report is clean, the button is enabled and submits.
 * The server enforces the same gate (unit-tested in
 * tests/unit/sars/efiling-submission.test.ts) — this proves the UI wiring.
 *
 * Run (dev server up + a golden run has produced the storageState):
 *   BASE_URL=http://localhost:3200 bunx playwright test \
 *     tests/e2e/sars-vat201-exceptions-gate.spec.ts --config playwright-standalone.config.ts
 */
import { test, expect, type Page } from '@playwright/test';

const GOLDEN_STATE_FILE = 'tests/e2e/.auth/golden-session.json';
test.use({ storageState: GOLDEN_STATE_FILE });

const VAT201_DATA = {
  periodStart: '2026-03-01', periodEnd: '2026-03-31',
  field1_standardRatedSupplies: 100000, field2_zeroRatedSupplies: 0, field3_exemptSupplies: 0,
  field4_totalImports: 0, field5_outputVAT: 15000,
  field6_capitalGoods: 0, field7_otherGoods: 5000, field8_services: 0, field9_imports: 0,
  field10_totalInputVAT: 5000, field11_vatPayableOrRefundable: 10000,
  outputInvoices: [], inputInvoices: [], degradedSources: [],
};

function report(totalExceptions: number) {
  return {
    periodStart: '2026-03-01', periodEnd: '2026-03-31',
    uncodedGlLines: [], uncodedGlLineCount: totalExceptions,
    invoiceTaxCodeIssues: [], invoiceTaxCodeIssueCount: 0,
    invoiceGlMismatches: [], invoiceGlMismatchCount: 0,
    controlRecon: {
      outputVat201: 15000, outputGl: 15000, outputVariance: 0,
      inputVat201: 5000, inputGl: 5000, inputVariance: 0,
      netVat201: 10000, netGl: 10000, netVariance: 0,
      unpostedCustomerVat: 0, unpostedCustomerCount: 0, unpostedSupplierVat: 0, unpostedSupplierCount: 0,
    },
    totalExceptions, degradedData: false, degradedSources: [],
  };
}

function ok(data: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) };
}

async function mockSars(page: Page, exceptionsCount: number): Promise<void> {
  await page.route('**/api/accounting/sars/efiling-status*', (r) =>
    r.fulfill(ok({ configured: true, baseUrlHost: 'mock-isv', channel: 'isv' })));
  await page.route('**/api/accounting/sars/vat-exceptions*', (r) => r.fulfill(ok(report(exceptionsCount))));
  await page.route('**/api/accounting/sars/sars-vat201*', (r) =>
    r.request().method() === 'POST' ? r.fulfill(ok({ id: 'sub-e2e-123' })) : r.fulfill(ok(VAT201_DATA)));
  await page.route('**/api/accounting/sars/efiling-submit*', (r) =>
    r.fulfill(ok({ submissionId: 'sub-e2e-123', correlationId: 'CORR-E2E', status: 'received' })));
}

async function generateAndSave(page: Page): Promise<void> {
  await page.goto('/accounting/sars/vat201');
  await page.getByRole('button', { name: /generate/i }).click();
  await expect(page.getByTestId('sars-submit-section')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /save draft/i }).click();
}

test('exceptions present → "do not file" banner blocks the SARS submit button', async ({ page }) => {
  await mockSars(page, 2);
  await generateAndSave(page);

  await expect(page.getByTestId('sars-do-not-file-banner')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sars-submit-btn')).toBeDisabled();
});

test('clean exceptions → submit is enabled and files to SARS', async ({ page }) => {
  await mockSars(page, 0);
  await generateAndSave(page);

  await expect(page.getByTestId('sars-do-not-file-banner')).toHaveCount(0);
  const btn = page.getByTestId('sars-submit-btn');
  await expect(btn).toBeEnabled({ timeout: 15_000 });
  await btn.click();
  await expect(page.getByText(/CORR-E2E/)).toBeVisible({ timeout: 15_000 });
});
