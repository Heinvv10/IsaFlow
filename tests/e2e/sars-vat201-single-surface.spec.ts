/**
 * One VAT201 surface (master plan D3 + D6).
 *
 *   - /accounting/reports/vat-return redirects to /accounting/sars/vat201 and
 *     keeps its query string;
 *   - the page prints the SARS field numbers (1, 1A ... 20), not rows 1-11;
 *   - the period label never shows the bi-monthly default to a monthly company,
 *     and Generate does not move once it is on screen;
 *   - the FIRST click on Generate sends the request.
 *
 * Why the last two: the period selector used to render before the company's VAT
 * settings loaded, so it printed "Bi-Monthly", flipped to "Monthly" and grew a
 * row of chips that pushed Generate down 46px. A click aimed at the first
 * position hit a chip: no request until the second click.
 *
 * Only the API is mocked, with the settings response held back so the old
 * window is wide. Run (dev server up; E2E_STORAGE_STATE a signed-in state):
 *   BASE_URL=http://localhost:3213 E2E_STORAGE_STATE=<state.json> bunx playwright test \
 *     tests/e2e/sars-vat201-single-surface.spec.ts --config playwright-standalone.config.ts
 */
import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: process.env.E2E_STORAGE_STATE ?? 'tests/e2e/.auth/golden-session.json' });

const SETTINGS_DELAY_MS = 2_500;
const FORM = [
  ['1', 'value', 11500], ['4', 'tax', 1500], ['1A', 'value', 0], ['4A', 'tax', 0], ['2', 'value', 0], ['2A', 'value', 4000],
  ['3', 'value', 2000], ['5', 'value', null], ['6', 'value', null], ['7', 'value', null], ['8', 'value', null],
  ['9', 'tax', null], ['10', 'value', null], ['11', 'tax', null], ['12', 'tax', 0], ['13', 'tax', 1500],
  ['14', 'tax', 750], ['14A', 'tax', null], ['15', 'tax', 900], ['15A', 'tax', 0], ['16', 'tax', 0],
  ['17', 'tax', 0], ['18', 'tax', 0], ['19', 'tax', 1650], ['20', 'tax', -150],
] as const;

const REPORT = {
  periodStart: '2026-09-01', periodEnd: '2026-09-30',
  sarsFields: FORM.map(([field, kind, amount]) => ({ field, label: `SARS field ${field}`, kind, group: 'output-supplies', amount })),
  warnings: [{ code: 'uncoded-revenue-assumed-zero-rated', amount: 800, message: 'Confirm the uncoded revenue.' }],
  filability: { filable: true, reason: null },
  outputInvoices: [], inputInvoices: [], degradedSources: [],
};
const ok = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

async function mockApi(page: Page, vatRequests: string[]): Promise<void> {
  await page.route(/\/api\/accounting\/companies\?id=/, async (route) => {
    await new Promise((r) => setTimeout(r, SETTINGS_DELAY_MS));
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill(ok({ ...json.data, vatPeriod: 'monthly', vatSystemType: 'invoice', vatPeriodAlignment: 'even' }));
  });
  await page.route('**/api/accounting/sars/sars-vat201*', (r) => {
    vatRequests.push(r.request().url());
    return r.fulfill(ok(REPORT));
  });
  await page.route('**/api/accounting/sars/vat-exceptions*', (r) => r.fulfill(ok({
    periodStart: '2026-09-01', periodEnd: '2026-09-30', uncodedGlLines: [], uncodedGlLineCount: 0,
    invoiceTaxCodeIssues: [], invoiceTaxCodeIssueCount: 0, billTaxCodeWarnings: [], billTaxCodeWarningCount: 0,
    billTaxCodeWarningPotentialVat: 0, invoiceGlMismatches: [], invoiceGlMismatchCount: 0,
    vatOnBalanceSheetLines: [], vatOnBalanceSheetCount: 0, vatNonSupplyLines: [], vatNonSupplyCount: 0,
    unpostedInvoiceVat: [], unpostedInvoiceVatCount: 0, declaredElsewhereVat: [], declaredElsewhereVatCount: 0,
    unsupportedInputVat: [], unsupportedInputVatCount: 0, inputVatWithoutTaxInvoice: [], inputVatWithoutTaxInvoiceCount: 0,
    controlRecon: {
      outputVat201: 1500, outputGl: 1500, outputVariance: 0, inputVat201: 1650, inputGl: 1650, inputVariance: 0,
      netVat201: -150, netGl: -150, netVariance: 0,
      unpostedCustomerVat: 0, unpostedCustomerCount: 0, unpostedSupplierVat: 0, unpostedSupplierCount: 0,
    },
    totalExceptions: 0, degradedData: false, degradedSources: [],
  })));
  await page.route('**/api/accounting/sars/efiling-status*', (r) => r.fulfill(ok({ configured: false })));
}

test('the retired VAT return report redirects to the one VAT201, keeping the query string', async ({ page }) => {
  await page.goto('/accounting/reports/vat-return?from=2026-03-01&to=2026-03-31');
  await expect(page).toHaveURL(/\/accounting\/sars\/vat201\?from=2026-03-01&to=2026-03-31$/);
  await expect(page.getByRole('heading', { name: 'VAT201 Return' })).toBeVisible({ timeout: 30_000 });
});

test('period label is stable and the first Generate click sends the request', async ({ page }) => {
  const vatRequests: string[] = [];
  await mockApi(page, vatRequests);
  await page.addInitScript(() => {
    const w = window as unknown as { __labels: string[]; __generateY: number[] };
    w.__labels = []; w.__generateY = [];
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const label = document.body.innerText.match(/Bi-Monthly[^\n]*|Monthly/)?.[0];
        if (label && w.__labels[w.__labels.length - 1] !== label) w.__labels.push(label);
        const button = [...document.querySelectorAll('button')].find((b) => /Generate/.test(b.textContent ?? ''));
        if (button) {
          const y = Math.round(button.getBoundingClientRect().y);
          if (w.__generateY[w.__generateY.length - 1] !== y) w.__generateY.push(y);
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  });

  await page.goto('/accounting/sars/vat201');
  // The settings are held back: no label and no button may show yet.
  await expect(page.getByTestId('vat201-period-loading')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /generate/i })).toHaveCount(0);

  const generate = page.getByRole('button', { name: /generate/i });
  await expect(generate).toBeVisible({ timeout: 30_000 });
  // Click at the coordinates the button had the moment it appeared, as a user would.
  const box = (await generate.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(page.getByTestId('vat201-sars-form')).toBeVisible({ timeout: 15_000 });
  expect(vatRequests, 'the first click must send exactly one request').toHaveLength(1);

  const seen = await page.evaluate(() => {
    const w = window as unknown as { __labels: string[]; __generateY: number[] };
    return { labels: w.__labels, generateY: w.__generateY };
  });
  expect(seen.labels, 'a monthly company must never be shown the bi-monthly default').toEqual(['Monthly']);
  expect(new Set(seen.generateY).size, 'Generate must not move once shown').toBe(1);
});

test('the page prints the official SARS field numbers with the server amounts', async ({ page }) => {
  await mockApi(page, []);
  await page.goto('/accounting/sars/vat201');
  await page.getByRole('button', { name: /generate/i }).click({ timeout: 30_000 });
  await expect(page.getByTestId('vat201-sars-form')).toBeVisible({ timeout: 15_000 });

  const numbers = await page.getByTestId('vat201-field-number').allTextContents();
  expect(numbers).toEqual(FORM.map(([field]) => field));
  await expect(page.getByTestId('vat201-field-13').getByTestId('vat201-field-amount')).toContainText(/1[\s ]?500[.,]00/);
  await expect(page.getByTestId('vat201-field-5').getByTestId('vat201-field-amount')).toHaveText('—');
  await expect(page.getByTestId('vat201-notice-uncoded-revenue-assumed-zero-rated')).toContainText('Confirm');
});
