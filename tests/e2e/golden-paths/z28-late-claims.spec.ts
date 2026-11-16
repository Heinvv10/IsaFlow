// golden:dev-only
/**
 * Golden path Z28 (wave 6 LC): the VAT201's late-claims section. READ-ONLY on the golden session's company (the Demo
 * company, or the CI slot's seeded copy), dev only.
 *
 * Picks the most recent two-month window of the last two years that has late input-VAT claims (s16(3)), or the latest
 * window when the company has none, generates the VAT201 and checks the section: its rows' VAT adds up to its total to
 * the cent, the total is the input boxes' late part the API states, every claim links to a journal entry, and the page
 * passes axe at 1568 and 390, light and dark, with no page scroll at 390. Nothing is written.
 * LATE_CLAIMS_EVIDENCE_DIR=<dir> saves a screenshot per width and theme. Z28_COMPANY_ID switches company for a local run.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'path';
import { Api } from './_api';
import { switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, settle } from '../helpers/themeSpec';

const evidenceDir = process.env.LATE_CLAIMS_EVIDENCE_DIR;
test.setTimeout(300_000);

interface Window_ { from: string; to: string; rows: number; lateClaimInputTax: number }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const text = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m! - 1]} ${y}`; };
/** 'R 1 234.50' or '−R 15.00' (a true minus sign) in rands. */
const money = (s: string): number => Number(s.replace(/−/g, '-').replace(/[^\d.-]/g, ''));

async function pickWindow(api: Api): Promise<Window_> {
  const now = new Date();
  let latest: Window_ | null = null;
  for (let back = 0; back < 12; back++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2 * back - 1, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 2, 0));
    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    const r = await api.get<{ rows: unknown[]; lateClaimInputTax: number }>(`/api/accounting/sars/vat201-late-claims?from=${from}&to=${to}`);
    const w = { from, to, rows: r.rows.length, lateClaimInputTax: r.lateClaimInputTax };
    if (w.rows > 0) return w;
    latest ??= w;
  }
  return latest!;
}

async function generate(page: Page, w: Window_): Promise<void> {
  for (const [label, iso] of [[/^Period Start/, w.from], [/^Period End/, w.to]] as const) {
    const field = page.getByLabel(label);
    await field.fill(text(iso));
    await field.press('Tab');
  }
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByTestId('vat201-sars-form')).toBeVisible({ timeout: 60_000 });
  const section = page.getByTestId('vat201-late-claims');
  await expect(section.getByTestId(w.rows > 0 ? 'vat201-late-claims-rows' : 'vat201-late-claims-empty')).toBeVisible({ timeout: 60_000 });
}

test('the late-claims section adds up to the input boxes\' late part and links each claim (read-only)', async ({ page, context, baseURL }) => {
  const api = await Api.login(baseURL!);
  const company = process.env.Z28_COMPANY_ID;
  if (company) {
    await switchApiCompany(api, company);
    await switchBrowserCompany(context, company);
  }
  const w = await pickWindow(api);
  await page.setViewportSize({ width: 1568, height: 1000 });
  await page.goto('/accounting/sars/vat201', { waitUntil: 'domcontentloaded' });
  await generate(page, w);

  const section = page.getByTestId('vat201-late-claims');
  if (w.rows > 0) {
    const table = section.getByTestId('vat201-late-claims-rows');
    const vats = await table.locator('tbody tr td:nth-child(6)').allTextContents();
    expect(vats).toHaveLength(w.rows);
    const cents = vats.reduce((s, t) => s + Math.round(money(t.replace(/\s/g, '')) * 100), 0);
    const total = money(((await section.getByTestId('vat201-late-claims-total').textContent()) ?? '').replace(/\s/g, ''));
    expect(cents, 'the rows add up to the total').toBe(Math.round(total * 100));
    expect(Math.round(total * 100), 'the total is the input boxes\' late part').toBe(Math.round(w.lateClaimInputTax * 100));
    const claimLinks = await table.locator('tbody tr td:nth-child(1) a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(claimLinks).toHaveLength(w.rows);
    for (const h of claimLinks) expect(h).toMatch(/^\/accounting\/journal-entries\/[0-9a-f-]{36}$/);
  } else {
    expect(w.lateClaimInputTax, 'no rows means no late part in the boxes').toBe(0);
  }
  console.log(`z28: window ${w.from}..${w.to}, ${w.rows} late-claim row(s), late part ${w.lateClaimInputTax}`);

  for (const theme of THEMES) {
    for (const width of [1568, 390]) {
      await page.evaluate((t) => window.localStorage.setItem('accounting-theme', t), theme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await generate(page, w);
      await settle(page);
      await section.scrollIntoViewIfNeeded();
      await expectNoSeriousA11yViolations(page, { key: `z28-late-claims-${theme}-${width}`, baseline: { pages: {} } });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `page scrolls sideways at ${width}`).toBeLessThanOrEqual(0);
      if (evidenceDir) await section.screenshot({ path: join(evidenceDir, `vat201-late-claims-${theme}-${width}.png`) });
    }
  }
});
