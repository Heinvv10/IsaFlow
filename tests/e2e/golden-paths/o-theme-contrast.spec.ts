/**
 * Golden path O - both themes meet WCAG AA on the main screens (master plan 3b.1).
 *
 * Each screen loads per theme and viewport (390 phone, 1280, 1920) with the preference pre-seeded,
 * then (1) axe's color-contrast rule must report nothing, (2) the computed-style walker in
 * tests/e2e/helpers/themeContrast.ts must find 0 text below 4.5:1 (3:1 large), and (3) `color-scheme`
 * must follow the theme so native select / date pop-ups render in it. Read-only: writes no data.
 *
 * Evidence mode: THEME_EVIDENCE_DIR=<dir> writes a screenshot per screen/theme/viewport and
 * contrast-<slug>.json; THEME_RECORD_ONLY=1 additionally skips the assertions (for "before" runs).
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { auditContrast } from '../helpers/themeContrast';
import { THEMES, axeContrastFailures, rootTheme, seedTheme, settle } from '../helpers/themeSpec';

const SCREENS = [
  { slug: 'dashboard', path: '/accounting' },
  { slug: 'customer-invoices', path: '/accounting/customer-invoices' },
  { slug: 'customer-invoice-new', path: '/accounting/customer-invoices/new' },
  { slug: 'bank-transactions', path: '/accounting/bank-transactions' },
  { slug: 'payroll-employees', path: '/payroll/employees' },
  { slug: 'income-statement', path: '/accounting/reports/income-statement' },
  { slug: 'vat201', path: '/accounting/sars/vat201' },
  { slug: 'balance-sheet', path: '/accounting/reports/balance-sheet' },
  { slug: 'trial-balance', path: '/accounting/trial-balance' },
  { slug: 'general-ledger', path: '/accounting/reports/general-ledger' },
  // Screens with white-in-both-themes panels (data-surface="light"): their grey text must hold on white in the dark theme.
  { slug: 'receipt-match', path: '/accounting/ar/receipt-match' },
  { slug: 'disputes', path: '/accounting/disputes' },
] as const;
const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1920', width: 1920, height: 1080 },
] as const;

const evidenceDir = process.env.THEME_EVIDENCE_DIR;
const recordOnly = process.env.THEME_RECORD_ONLY === '1';
const results: Record<string, unknown> = {};

test.setTimeout(240_000);

for (const screen of SCREENS) {
  test(`${screen.slug}: AA contrast in light and dark at 390, 1280 and 1920`, async ({ page }) => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of THEMES) {
        const key = `${screen.slug}.${theme}.${viewport.name}`;
        await seedTheme(page, theme);
        await page.goto(screen.path, { waitUntil: 'domcontentloaded' });
        await settle(page);

        const scheme = (await rootTheme(page)).scheme;
        const walker = await auditContrast(page);
        const axe = await axeContrastFailures(page);
        results[key] = { walker, axeFailing: axe.length };
        if (evidenceDir) {
          mkdirSync(evidenceDir, { recursive: true });
          await page.screenshot({ path: join(evidenceDir, `${key}.png`) });
          const mine = Object.fromEntries(Object.entries(results).filter(([k]) => k.startsWith(`${screen.slug}.`)));
          writeFileSync(join(evidenceDir, `contrast-${screen.slug}.json`), JSON.stringify(mine, null, 2));
        }
        if (recordOnly) continue;

        expect(scheme, `${key}: color-scheme`).toBe(theme);
        expect(await page.locator('h1').count(), `${key}: one page title`).toBe(1);
        const detail = walker.failing.slice(0, 8).map((f) => `${f.ratio}<${f.required} ${f.el} "${f.text}"`);
        expect(walker.failing, `${key}: text below AA\n${detail.join('\n')}`).toHaveLength(0);
        expect(axe, `${key}: axe color-contrast`).toEqual([]);
      }
    }
  });
}
