/**
 * Golden path (u): list and period filter dates are typed DateFields (master plan wave 1, F2).
 *
 * Read-only. On bank transactions, aged debtors and the VAT201 period picker:
 *   - typed text ("1 Sep 2026", "t") reaches the request as an ISO date;
 *   - unreadable text ("zz") shows an error and sends no request;
 *   - every date control is a labelled text field, not a native date input.
 * EVIDENCE_DIR=<dir> also saves a screenshot of each screen; THEME=light|dark picks the theme it is taken in.
 */
import { expect, request as pwRequest, test, type Page, type Request } from '@playwright/test';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const THEME = process.env.THEME === 'light' ? 'light' : 'dark';
const ISO = /^\d{4}-\d{2}-\d{2}$/;

interface Screen { path: string; heading: string }
const BANK: Screen = { path: '/accounting/bank-transactions', heading: 'Bank Transactions' };
const AGING: Screen = { path: '/accounting/ar-aging', heading: 'AR Aging Report' };
const VAT201: Screen = { path: '/accounting/sars/vat201', heading: 'VAT201 Return' };

/**
 * `next dev` compiles a route on its first request and then tells every open page to do a full reload ("Fast Refresh had
 * to perform a full reload"). That reload raced the next page.goto in CI (net::ERR_ABORTED at /accounting/ar-aging).
 * Requesting each route once before any page is open makes the compile happen with no page to reload.
 */
test.beforeAll(async () => {
  const { baseURL, storageState } = test.info().project.use;
  const ctx = await pwRequest.newContext({ baseURL, storageState });
  try {
    for (const s of [BANK, AGING, VAT201]) {
      const res = await ctx.get(s.path, { timeout: 120_000 });
      expect(res.status(), `warm-up ${s.path}`).toBe(200);
    }
  } finally {
    await ctx.dispose();
  }
});

async function openScreen(page: Page, s: Screen): Promise<void> {
  await page.goto(s.path);
  await expect(page.getByRole('heading', { name: s.heading, exact: true })).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname, 'no redirect').toBe(s.path);
  await page.locator('input[placeholder="dd MMM yyyy"]').first().waitFor({ state: 'visible', timeout: 30_000 });
}

async function snap(page: Page, name: string): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${THEME}.png`, fullPage: false });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => window.localStorage.setItem('accounting-theme', t), THEME);
});

/** Types into a DateField and commits with Tab (DateField commits on blur / Enter). */
async function typeDate(page: Page, label: string | RegExp, text: string): Promise<void> {
  const field = page.getByLabel(label);
  await field.fill(text);
  await field.press('Tab');
}

function watch(page: Page, pattern: RegExp): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => { if (pattern.test(r.url())) seen.push(r); });
  return seen;
}

test('no native date input is left on the three screens', async ({ page }) => {
  for (const s of [BANK, AGING, VAT201]) {
    await openScreen(page, s);
    await expect(page.locator('input[type="date"]'), `${s.path} has no input[type=date]`).toHaveCount(0);
  }
});

test('bank transactions: typed From date filters by ISO; unreadable text sends nothing', async ({ page }) => {
  await openScreen(page, BANK);
  const calls = watch(page, /\/api\/accounting\/bank-transactions\?/);
  await typeDate(page, 'From date', '1 Sep 2026');
  await expect.poll(() => calls.some((r) => new URL(r.url()).searchParams.get('from_date') === '2026-09-01')).toBe(true);
  await expect(page.getByLabel('From date')).toHaveValue('01 Sep 2026');
  const before = calls.length;
  await typeDate(page, 'To date', 'zz');
  await expect(page.getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(calls.length, 'refused text must not fetch').toBe(before);
  await snap(page, 'bank-transactions-invalid');
});

test('aged debtors: "t" as the as-at date requests today in ISO', async ({ page }) => {
  await openScreen(page, AGING);
  const calls = watch(page, /\/api\/accounting\/ar-aging\?/);
  await typeDate(page, /^As at/, '1 Jan 2026');
  await expect.poll(() => calls.some((r) => new URL(r.url()).searchParams.get('as_at_date') === '2026-01-01')).toBe(true);
  await typeDate(page, /^As at/, 't');
  await expect.poll(() => {
    const last = calls[calls.length - 1];
    return last ? new URL(last.url()).searchParams.get('as_at_date') : null;
  }).toMatch(ISO);
  const last = new URL(calls[calls.length - 1]!.url()).searchParams.get('as_at_date')!;
  expect(last).not.toBe('2026-01-01');
  await snap(page, 'ar-aging');
});

test('VAT201: typed period commits and Generate sends the ISO range', async ({ page }) => {
  await openScreen(page, VAT201);
  const calls = watch(page, /\/api\/accounting\/sars\/sars-vat201\?/);
  await typeDate(page, /^Period Start/, '1 Sep 2026');
  await typeDate(page, /^Period End/, '30 Sep 2026');
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect.poll(() => calls.some((r) => {
    const q = new URL(r.url()).searchParams;
    return q.get('from') === '2026-09-01' && q.get('to') === '2026-09-30';
  })).toBe(true);
  const before = calls.length;
  await typeDate(page, /^Period End/, 'zz');
  await expect(page.getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Generate' }).click();
  await page.waitForTimeout(500);
  const q = new URL(calls[calls.length - 1]!.url()).searchParams;
  expect(q.get('to'), 'the refused text never replaced the last good end date').toBe('2026-09-30');
  expect(calls.length).toBeGreaterThanOrEqual(before);
  await snap(page, 'vat201-period');
});
