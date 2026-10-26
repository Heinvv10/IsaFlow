/**
 * Golden path X - the off-core pages the wave-0 re-score found below AA (master plan wave 1, PR X).
 *
 * Each page loads in both themes at 1280 and the computed-style walker (tests/e2e/helpers/themeContrast.ts)
 * must find 0 text below AA. /accounting/disputes must also paint a theme-matching panel (no white card in dark).
 * Read-only. Evidence mode: THEME_EVIDENCE_DIR=<dir> writes screenshots and contrast-x.json;
 * THEME_RECORD_ONLY=1 skips the assertions (for the "before" run).
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { auditContrast } from '../helpers/themeContrast';

const THEMES = ['light', 'dark'] as const;

/**
 * minTexts is a render check, not a data count: each floor is about 40-47% of what auditContrast measured on dev
 * (Demo company) on 2026-10-26 (ap-aging 9042, supplier-invoices 460, journal-entries-new 43, assets-new 45,
 * dunning-runs 43, disputes 28, recurring-invoices 26, delivery-notes 20), so ordinary data churn cannot fail it
 * but a page that rendered only its shell does.
 */
const PAGES = [
  { slug: 'ap-aging', path: '/accounting/reports/ap-aging', minTexts: 500 },
  { slug: 'dunning-runs', path: '/accounting/ar/dunning/runs', minTexts: 20 },
  { slug: 'supplier-invoices', path: '/accounting/supplier-invoices', minTexts: 150 },
  { slug: 'recurring-invoices', path: '/accounting/recurring-invoices', minTexts: 12 },
  { slug: 'delivery-notes', path: '/accounting/delivery-notes', minTexts: 10 },
  { slug: 'journal-entries-new', path: '/accounting/journal-entries/new', minTexts: 20 },
  { slug: 'assets-new', path: '/accounting/assets/new', minTexts: 20 },
  { slug: 'disputes', path: '/accounting/disputes', minTexts: 12 },
] as const;

/** Wait for the shell and for spinners/skeletons to clear. */
async function settle(page: Page): Promise<void> {
  await page.waitForSelector('main', { timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('.animate-spin, .animate-pulse, [aria-busy="true"]'), undefined, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** A list page is measured with its rows (or its empty-state text) on screen, not while the table is still empty. */
async function rowsReady(page: Page, path: string): Promise<void> {
  if (/\/new$/.test(path)) return;
  await page.waitForSelector('tbody tr, main :text-matches("^No [a-z ]+", "i")', { timeout: 30_000 });
}

const evidenceDir = process.env.THEME_EVIDENCE_DIR;
const recordOnly = process.env.THEME_RECORD_ONLY === '1';
const results: Record<string, unknown> = {};

test.setTimeout(240_000);

for (const pg of PAGES) {
  test(`${pg.slug}: AA contrast in light and dark`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const theme of THEMES) {
      const key = `${pg.slug}.${theme}`;
      await page.addInitScript((t) => window.localStorage.setItem('accounting-theme', t), theme);
      await page.goto(pg.path, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await rowsReady(page, pg.path);
      const walker = await auditContrast(page);
      // Largest painted-white panel inside <main> (dark theme must not contain one).
      const whitePanel = await page.evaluate(() => {
        const area = innerWidth * innerHeight;
        for (const el of Array.from(document.querySelectorAll('main *'))) {
          const b = el.getBoundingClientRect();
          if (b.width * b.height < area * 0.08) continue;
          const m = getComputedStyle(el).backgroundColor.match(/\d+/g);
          if (m && +m[0] > 235 && +m[1] > 235 && +m[2] > 235) return `${el.tagName}.${String(el.className).slice(0, 40)}`;
        }
        return null;
      });
      results[key] = { walker, whitePanel };
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot({ path: join(evidenceDir, `${key}.png`) });
        writeFileSync(join(evidenceDir, 'contrast-x.json'), JSON.stringify(results, null, 2));
      }
      if (recordOnly) continue;
      expect(walker.total, `${key}: page measured (rows/inputs rendered)`).toBeGreaterThanOrEqual(pg.minTexts);
      const detail = walker.failing.slice(0, 8).map((f) => `${f.ratio}<${f.required} ${f.el} "${f.text}"`);
      expect(walker.failing, `${key}: text below AA\n${detail.join('\n')}`).toHaveLength(0);
      if (theme === 'dark') expect(whitePanel, `${key}: white panel inside dark theme`).toBeNull();
    }
  });
}
