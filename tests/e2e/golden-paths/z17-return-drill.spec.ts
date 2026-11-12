// golden:dev-only
/**
 * Golden path Z17 (wave 5 L3u): drill from a VAT201 field to the lines behind it. READ-ONLY on the golden session's company (the Demo company, or the CI slot's seeded copy), dev only.
 *
 * Finds a window in that company with a non-zero tax-leg field (field 4 where there is output VAT, else an input field: GitHub's hosted
 * seed has supplier invoices only), generates the VAT201, opens that field's drawer and checks that the
 * lines (every page) sum to the field's amount to the cent, that each row links to a journal entry, and that the drawer
 * passes axe at 1568 and 390, light and dark, with no page scroll at 390. A field with no amount offers no link.
 * A second test does the same for EMP201 PAYE (skipped where the company has no approved pay run): the pay runs and
 * employee lines, run links, "matches the amount", axe. Nothing is written. RETURN_EVIDENCE_DIR=<dir> saves a screenshot per width and theme.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'path';
import { Api } from './_api';
import { switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, settle } from '../helpers/themeSpec';

const evidenceDir = process.env.RETURN_EVIDENCE_DIR;
test.setTimeout(300_000);

/** The window and the tax-leg field the golden drills. */
interface Pick_ { from: string; to: string; field: string; amount: number }
const TAX_FIELDS = ['4', '15', '14', '15A', '17'] as const;
interface Field { field: string; amount: number | null }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const text = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m! - 1]} ${y}`; };

/**
 * A one-week window of the last two years where a tax-leg field is non-zero and its lines fit in five pages
 * (at most 1000: a busy period would page past the drill's rate limit). One with more than a page (200) is preferred,
 * so the paging is exercised; failing that, any.
 */
async function busyPeriod(api: Api): Promise<Pick_> {
  const now = new Date();
  let fallback: Pick_ | null = null;
  let probes = 0;
  for (let back = 0; back < 104 && probes < 40; back++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7 * (back + 1)));
    const end = new Date(start.getTime() + 6 * 86_400_000);
    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    const r = await api.get<{ sarsFields: Field[] }>(`/api/accounting/sars/sars-vat201?from=${from}&to=${to}`);
    const field = TAX_FIELDS.find((id) => r.sarsFields.find((f) => f.field === id)?.amount);
    const amount = field ? r.sarsFields.find((f) => f.field === field)?.amount : null;
    if (!field || !amount) continue;
    probes++;
    const d = await api.get<{ rowCount: number; hasMore: boolean }>(`/api/accounting/sars/return-drill?return=vat201&field=${field}&from=${from}&to=${to}&pageSize=200`);
    if (d.rowCount === 0 || d.rowCount > 1000) continue;
    if (d.rowCount > 200) return { from, to, field, amount };
    fallback ??= { from, to, field, amount };
  }
  if (fallback) return fallback;
  throw new Error('The golden company has no VAT201 period with a non-zero tax field and at most 1000 lines in a week of the last two years');
}

async function generate(page: Page, p: { from: string; to: string }): Promise<void> {
  for (const [label, iso] of [[/^Period Start/, p.from], [/^Period End/, p.to]] as const) {
    const field = page.getByLabel(label);
    await field.fill(text(iso));
    await field.press('Tab');
  }
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByTestId('vat201-sars-form')).toBeVisible({ timeout: 60_000 });
}

/** 'R 1 234.50' or '\u2212R 15.00' (the formatter writes a true minus sign) in rands. */
const money = (s: string): number => Number(s.replace(/\u2212/g, '-').replace(/[^\d.-]/g, ''));

test('a tax field drills to lines that sum to the field; axe clean (read-only)', async ({ page, context, baseURL }) => {
  const api = await Api.login(baseURL!);
  // The golden session is already scoped to its company (the CI slot's, or the user's default Demo); never switch by a
  // dev id, since a hosted slot user is not a member of it. Z17_COMPANY_ID is for a local run as a user whose default
  // company is not the Demo company (the CI job never sets it).
  const company = process.env.Z17_COMPANY_ID;
  if (company) {
    await switchApiCompany(api, company);
    await switchBrowserCompany(context, company);
  }
  const p = await busyPeriod(api);
  await page.setViewportSize({ width: 1568, height: 1000 });
  await page.goto('/accounting/sars/vat201', { waitUntil: 'domcontentloaded' });
  await generate(page, p);

  await expect(page.getByTestId('vat201-field-5').getByTestId('vat201-field-drill')).toHaveCount(0);

  const drawer = page.getByTestId('return-drill-drawer');
  await page.getByTestId(`vat201-field-${p.field}`).getByTestId('vat201-field-drill').click();
  await expect(drawer.getByTestId('return-drill-lines')).toBeVisible({ timeout: 60_000 });

  // Sum every page of the lines and compare with the field's amount, in cents.
  let cents = 0;
  let pages = 0;
  for (;;) {
    pages++;
    await settle(page);
    const taxes = await drawer.getByTestId('return-drill-lines').locator('tbody tr td:nth-child(4)').allTextContents();
    cents += taxes.reduce((s, t) => s + Math.round(money(t.replace(/\s/g, '')) * 100), 0);
    const links = await drawer.getByTestId('return-drill-lines').locator('tbody a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    for (const h of links) expect(h).toMatch(/^\/accounting\/journal-entries\/[0-9a-f-]{36}$/);
    const next = drawer.getByRole('button', { name: 'Next' });
    if (await next.isDisabled()) break;
    await next.click();
    await expect(drawer.getByTestId('return-drill-range')).toContainText(`Showing ${pages * 200 + 1}–`, { timeout: 30_000 });
  }
  expect(cents).toBe(Math.round(p.amount * 100));
  await expect(drawer.getByTestId('return-drill-total')).toContainText('matches the field');
  console.log(`z17: period ${p.from}..${p.to}, field ${p.field} = ${p.amount}, ${pages} page(s) of lines sum to it`);

  for (const theme of THEMES) {
    for (const width of [1568, 390]) {
      await page.evaluate((t) => window.localStorage.setItem('accounting-theme', t), theme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await generate(page, p);
      await page.getByTestId(`vat201-field-${p.field}`).getByTestId('vat201-field-drill').click();
      await expect(drawer.getByTestId('return-drill-lines')).toBeVisible({ timeout: 60_000 });
      await settle(page);
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      await expectNoSeriousA11yViolations(page, { key: `z17-drill-${theme}-${width}`, baseline: { pages: {} } });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `page scrolls sideways at ${width}`).toBeLessThanOrEqual(0);
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `vat201-drill-${theme}-${width}.png`) });
    }
  }
});

/** The latest calendar month of the last two years whose EMP201 PAYE is non-zero, or null when the company has no pay runs. */
async function payrollMonth(api: Api): Promise<{ from: string; to: string } | null> {
  const now = new Date();
  for (let back = 1; back <= 24; back++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const from = start.toISOString().slice(0, 10);
    const to = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const r = await api.get<{ totalPAYE: number }>(`/api/accounting/sars/sars-emp201?from=${from}&to=${to}`);
    if (r.totalPAYE) return { from, to };
  }
  return null;
}

async function openPaye(page: Page, month: { from: string; to: string }): Promise<void> {
  await page.goto('/accounting/sars/emp201', { waitUntil: 'domcontentloaded' });
  for (const [label, iso] of [['From', month.from], ['To', month.to]] as const) {
    const field = page.getByLabel(new RegExp(`^${label}`));
    await field.fill(text(iso));
    await field.press('Tab');
  }
  await page.getByRole('button', { name: 'Generate' }).click();
  await page.getByRole('button', { name: 'Show the lines behind PAYE (Pay As You Earn)' }).click();
  await expect(page.getByTestId('emp201-drill-drawer').getByTestId('return-drill-lines')).toBeVisible({ timeout: 60_000 });
}

/**
 * The drawer's "EMP201 amount" is the form's PAYE figure, and its employee lines (every page) plus its directive payments
 * add up to it to the cent.
 */
async function expectDrawerTiesToForm(page: Page): Promise<void> {
  const drawer = page.getByTestId('emp201-drill-drawer');
  const onForm = money((await page.getByText('PAYE (Pay As You Earn)', { exact: true }).locator('xpath=..').getByTestId('emp201-value').textContent()) ?? '');
  expect(money((await drawer.getByTestId('emp201-drill-amount').textContent()) ?? ''), 'the drawer shows the form\'s PAYE').toBe(onForm);
  expect(onForm, 'the seeded run has PAYE to drill').not.toBe(0);
  let cents = 0;
  let pages = 0;
  for (;;) {
    pages++;
    const amounts = await drawer.getByTestId('return-drill-lines').locator('tbody tr td:nth-child(3)').allTextContents();
    cents += amounts.reduce((s, t) => s + Math.round(money(t) * 100), 0);
    const next = drawer.getByRole('button', { name: 'Next' });
    if (await next.isDisabled()) break;
    await next.click();
    await expect(drawer.getByTestId('return-drill-range')).toContainText(`Showing ${(pages * 200) + 1}\u2013`, { timeout: 30_000 });
  }
  for (const t of await drawer.getByTestId('emp201-drill-directive-amount').allTextContents()) cents += Math.round(money(t) * 100);
  expect(cents, 'employee lines plus directive payments add up to the form figure').toBe(Math.round(onForm * 100));
}

test('EMP201 PAYE drills to the pay runs and employee lines it sums; axe clean (read-only)', async ({ page, context, baseURL }) => {
  const api = await Api.login(baseURL!);
  const company = process.env.Z17_COMPANY_ID;
  if (company) {
    await switchApiCompany(api, company);
    await switchBrowserCompany(context, company);
  }
  const month = await payrollMonth(api);
  // The hosted seed approves one pay run (seed-demo-app.ts seedPayRun), so in CI a missing month is a failure, not a skip.
  if (month === null) {
    if (process.env.CI) throw new Error('the golden company has no approved pay run in the last two years: the hosted seed (seedPayRun) did not seed one');
    test.skip(true, 'the golden company has no approved pay run in the last two years');
  }
  const drawer = page.getByTestId('emp201-drill-drawer');
  for (const theme of THEMES) {
    for (const width of [1568, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.addInitScript((t) => window.localStorage.setItem('accounting-theme', t), theme);
      await openPaye(page, month!);
      if (theme === THEMES[0] && width === 1568) await expectDrawerTiesToForm(page);
      await expect(drawer.getByTestId('return-drill-total')).toContainText('matches the amount');
      for (const href of await drawer.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
        expect(href).toMatch(/^\/payroll\/runs\/[0-9a-f-]{36}$/);
      }
      await settle(page);
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      await expectNoSeriousA11yViolations(page, { key: `z17-emp201-${theme}-${width}`, baseline: { pages: {} } });
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `emp201-drill-${theme}-${width}.png`) });
    }
  }
});
