// golden:dev-only
/**
 * Golden path (z3): the P&L exports as a PDF (master plan wave 3, PR P).
 *
 * An API-level request for a fixed past period: the route answers a real PDF, not an error page. Dev-only: in the
 * post-deploy run it would spend the company's report rate limit (a 429 there rolls the deploy back) on Demo data
 * nobody has checked. The figures are proved by income-statement-pdf-ties.int.test.ts. Read-only.
 */
import { expect, test } from '@playwright/test';

const PDF_URL = '/api/accounting/income-statement-pdf?period_start=2026-01-01&period_end=2026-01-31';

test('P&L PDF: the route answers a real PDF', async ({ page }) => {
  const res = await page.request.get(PDF_URL);
  expect(res.status(), await res.text().catch(() => '')).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect(res.headers()['content-disposition']).toContain('income-statement-2026-01-01-to-2026-01-31.pdf');
  const body = await res.body();
  expect(body.subarray(0, 4).toString()).toBe('%PDF');
  expect(body.length).toBeGreaterThan(1000);
});
