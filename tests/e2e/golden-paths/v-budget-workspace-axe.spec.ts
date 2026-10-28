// golden:dev-only
/**
 * Golden path (v, axe): the budget workspace scanned with axe in light and dark at 1280, report-only
 * (serious/critical rules as annotations, the full result attached; never a failure).
 *
 * Split from v-budget-workspace because it loads @axe-core/playwright, a dev/CI tool that
 * playwright-golden.config.ts skips for the post-deploy run (GOLDEN_SKIP_A11Y=1). Read-only: it opens the
 * workspace on its default year and version and writes nothing.
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { seedTheme, THEMES } from '../helpers/themeSpec';
import { WORKSPACE } from '../helpers/budgetWorkspace';

async function axeReport(page: Page, tag: string): Promise<void> {
  const info = test.info();
  const results = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  await info.attach(`axe-${tag}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  info.annotations.push({
    type: 'a11y-report',
    description: `${tag}: ${serious.length === 0 ? 'no serious/critical violations' : serious.map((v) => `[${v.impact}] ${v.id} ×${v.nodes.length}`).join(', ')}`,
  });
}

for (const theme of THEMES) {
  test(`budget workspace, ${theme}, 1280: axe report`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedTheme(page, theme);
    await page.goto(WORKSPACE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await expect(page.getByTestId('workspace-loading')).toHaveCount(0, { timeout: 120_000 });
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    await axeReport(page, `${theme}-1280`);
  });
}
