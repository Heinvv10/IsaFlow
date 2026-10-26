/**
 * Golden path (q2): the top-nav menu is axe-clean with a menu and a sub-panel open, in both themes
 * (`shell:top-nav-menu`, no baseline entries). EVIDENCE=1 saves the screenshots to docs/evidence.
 *
 * Split from q-top-nav-hover because it loads @axe-core/playwright, a dev/CI gate that
 * playwright-golden.config.ts ignores for the post-deploy run (GOLDEN_SKIP_A11Y=1).
 */
import { mkdirSync } from 'fs';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, THEMES } from '../helpers/themeSpec';
import { test, expect, openWithNav, NAV_READY_MS } from '../helpers/navSpec';

const NAV = 'nav:has([data-tour="nav-dashboard"])';
const EVIDENCE_DIR = 'docs/evidence/master-plan/wave1/nav';

for (const theme of THEMES) {
  test(`${theme} theme: menu and sub-panel are axe-clean`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedTheme(page, theme);
    // The scan covers the nav only, so wait for the nav and the theme, not for the dashboard's widgets to stop spinning.
    await openWithNav(page, '/accounting');
    await page.waitForSelector(`html[data-theme-applied="${theme}"]`, { timeout: NAV_READY_MS });
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

for (const theme of THEMES) {
  test(`${theme} theme: a hovered top tab and a keyboard-focused top tab are axe-clean`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedTheme(page, theme);
    // The scan covers the nav only, so wait for the nav and the theme, not for the dashboard's widgets to stop spinning.
    await openWithNav(page, '/accounting');
    await page.waitForSelector(`html[data-theme-applied="${theme}"]`, { timeout: NAV_READY_MS });
    // A hovered tab with no menu (hover colour on the bare tab) and one with a menu open.
    await page.locator('[data-tour="nav-workbench"] a').hover();
    await expectNoSeriousA11yViolations(page, { include: [NAV], key: 'shell:top-nav-menu', includeShell: true });
    await page.locator('[data-tour="nav-purchases"] a').first().hover();
    await expectNoSeriousA11yViolations(page, { include: [NAV], key: 'shell:top-nav-menu', includeShell: true });
    // Keyboard modality, so :focus-visible styles apply.
    await page.mouse.move(640, 600);
    await page.keyboard.press('Tab');
    await page.locator('[data-tour="nav-reports"] a').first().focus();
    await expect(page.locator('[data-tour="nav-reports"] a').first()).toBeFocused();
    await expectNoSeriousA11yViolations(page, { include: [NAV], key: 'shell:top-nav-menu', includeShell: true });
    await page.locator('[data-tour="nav-reports"] button').first().focus();
    await expectNoSeriousA11yViolations(page, { include: [NAV], key: 'shell:top-nav-menu', includeShell: true });
  });
}
