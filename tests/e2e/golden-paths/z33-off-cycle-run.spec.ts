// golden:dev-only
/**
 * Golden path (z33): the new off-cycle run page (master plan wave 6, OC).
 *
 *  - The Payroll runs list links to it ("Off-cycle run"), and it opens with its month, reason, pay date and employees.
 *  - In a company with no approved regular run the month list says so, the pay date stays disabled until a month is
 *    chosen, and the employees ask for the month first: an off-cycle run supplements an approved regular run.
 *  - axe reports 0 critical and 0 serious, in both themes, at 1280 and 390; 390 does not scroll sideways.
 *  - EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it creates (once) its own empty sandbox company and runs axe; it writes nothing else and never uses Demo.
 * Creating, costing and approving an off-cycle run is proved by tests/integration/w6-oc-off-cycle.int.test.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';
import { guardDevTarget } from '../helpers/devTarget';

guardDevTarget(test);

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX = { name: '0GP Golden Off-cycle Sandbox', onboardingId: '8c4f2e6a-1d3b-4a7c-9e5f-2b6d8a0c4e13' };

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

async function openPage(page: Page): Promise<void> {
  await page.goto('/payroll/runs/off-cycle', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'New off-cycle run' })).toBeVisible({ timeout: 60_000 });
  await settle(page);
}

for (const theme of THEMES) {
  test(`the off-cycle run page asks for an approved regular run first; no serious axe violation at 1280 and 390 (${theme})`, async ({ page, context, baseURL }) => {
    const api = await Api.login(baseURL!);
    try {
      const sandboxId = await findOrCreateSandbox(api, SANDBOX);
      await switchApiCompany(api, sandboxId);
      await switchBrowserCompany(context, sandboxId);
    } finally {
      await api.dispose();
    }
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto('/payroll/runs', { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Off-cycle run' }).first().click({ timeout: 60_000 });
    await page.waitForURL(/\/payroll\/runs\/off-cycle$/, { timeout: 60_000 });
    await openPage(page);

    await expect(page.getByText('Choose the month first.', { exact: true })).toBeVisible();
    await expect(page.locator('#oc-date')).toBeDisabled();
    await page.locator('#oc-month').click();
    await expect(page.getByText('No approved regular run yet')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');

    expect(await seriousAxe(page)).toEqual([]);
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/off-cycle-empty-1280-${theme}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(width.scroll, 'the page must not scroll sideways').toBeLessThanOrEqual(width.client);
    expect(await seriousAxe(page)).toEqual([]);
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/off-cycle-empty-390-${theme}.png`, fullPage: true });
  });
}
