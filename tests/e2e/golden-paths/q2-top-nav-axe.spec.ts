/**
 * Golden path (q2): the top-nav menu is axe-clean with a menu and a sub-panel open, in both themes
 * (`shell:top-nav-menu`, no baseline entries). EVIDENCE=1 saves the screenshots to docs/evidence.
 *
 * Split from q-top-nav-hover because it loads @axe-core/playwright, a dev/CI gate that
 * playwright-golden.config.ts ignores for the post-deploy run (GOLDEN_SKIP_A11Y=1).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const NAV = 'nav:has([data-tour="nav-dashboard"])';
const EVIDENCE_DIR = 'docs/evidence/master-plan/wave1/nav';

for (const theme of THEMES) {
  test(`${theme} theme: menu and sub-panel are axe-clean`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedTheme(page, theme);
    await page.goto('/accounting');
    await settle(page);
    await page.locator('[data-tour="nav-sales"]').hover();
    await page.locator('[data-tour="nav-sales"]').getByRole('button', { name: 'Customers' }).hover();
    await expect(page.locator('[data-tour="nav-sales"]').getByRole('link', { name: 'Debtors Manager' })).toBeVisible();
    if (process.env.EVIDENCE === '1') {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${EVIDENCE_DIR}/top-nav-sales-${theme}.png`, clip: { x: 0, y: 0, width: 1280, height: 520 } });
    }
    await expectNoSeriousA11yViolations(page, { include: [NAV], key: `shell:top-nav-menu`, includeShell: true });
  });
}
