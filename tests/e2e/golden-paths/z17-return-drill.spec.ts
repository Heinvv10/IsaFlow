// golden:dev-only
/**
 * Golden path Z17 (wave 5 L3u): drill from a VAT201 field to the lines behind it. READ-ONLY on the Demo company, dev only.
 *
 * Finds a window on Demo with a non-zero tax-leg field (field 4 where there is output VAT, else an input field: GitHub's hosted
 * Demo is seeded with supplier invoices only), generates the VAT201, opens that field's drawer and checks that the
 * lines (every page) sum to the field's amount to the cent, that each row links to a journal entry, and that the drawer
 * passes axe at 1568 and 390, light and dark, with no page scroll at 390. A field with no amount offers no link.
 * Nothing is written. RETURN_EVIDENCE_DIR=<dir> saves a screenshot per width and theme.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'path';
import { Api } from './_api';
import { switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, settle } from '../helpers/themeSpec';

const DEMO = '00000000-0000-0000-0000-000000000001';
const evidenceDir = process.env.RETURN_EVIDENCE_DIR;
test.setTimeout(300_000);

/** The window and the tax-leg field the golden drills. */
interface Pick_ { from: string; to: string; field: string; amount: number }
const TAX_FIELDS = ['4', '15', '14', '15A', '17'] as const;
interface Field { field: string; amount: number | null }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const text = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m! - 1]} ${y}`; };

/**
 * A one-week window of the last two years where a tax-leg field is non-zero and its lines fit in four pages
 * (at most 200: a busy period would page past the drill's rate limit). One with more than a page is preferred,
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
    if (d.hasMore || d.rowCount === 0) continue;
    if (d.rowCount > 50) return { from, to, field, amount };
    fallback ??= { from, to, field, amount };
  }
  if (fallback) return fallback;
  throw new Error('Demo has no VAT201 period with a non-zero tax field and at most 200 lines in a week of the last two years');
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

test('a tax field drills to lines that sum to the field; axe clean (Demo, read-only)', async ({ page, context, baseURL }) => {
  const api = await Api.login(baseURL!);
  await switchApiCompany(api, DEMO);
  await switchBrowserCompany(context, DEMO);
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
    await expect(drawer.getByText(`Page ${pages + 1}`, { exact: true })).toBeVisible({ timeout: 30_000 });
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
