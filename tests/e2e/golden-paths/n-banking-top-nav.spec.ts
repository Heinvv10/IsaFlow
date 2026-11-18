/**
 * Golden path (n): the Banking top-nav dropdown offers the daily banking set
 * and each link lands on its page.
 *
 * Regression for master-plan D6: the dropdown showed only "Banking Settings"
 * (operational items sat behind hover-only section rows). Read-only: no data
 * is created. The menu opens on hover (q-top-nav-hover covers the keyboard).
 *
 * Hover race (2026-11-15): on a loaded velo (load ~65) the deploy's own run hung 90 s on 'Reconcile' and 'Import
 * Statement' ("Transfers" intercepts pointer events, then the link detaches). The hover menu closes on pointerleave
 * and opens on pointerenter only, so a menu re-rendered or closed under a still pointer never reopens by itself and a
 * bare click() retries against it until the test timeout. Same fix as q-top-nav-hover: wait for the nav, warm the
 * route, then retry the whole hover+click (leave the nav, enter it again) in short attempts. A menu that never opens,
 * or a link that is really covered, still fails at 30 s.
 */
import { test, expect, openWithNav, waitForRoute, waitForClickNavigation } from '../helpers/navSpec';

const LINKS: Array<{ name: string; path: RegExp }> = [
  { name: 'Bank Transactions', path: /\/accounting\/bank-transactions$/ },
  { name: 'Reconcile', path: /\/accounting\/bank-reconciliation$/ },
  { name: 'Transfers', path: /\/accounting\/bank-transfers$/ },
  { name: 'Import Statement', path: /\/accounting\/bank-reconciliation\/import$/ },
];

const ATTEMPT_MS = 3_000;
const OPEN_BUDGET_MS = 30_000;

for (const { name, path } of LINKS) {
  test(`Banking top-nav → ${name}`, async ({ page }) => {
    await openWithNav(page, '/accounting');
    const banking = page.locator('[data-tour="nav-banking"]');
    const target = banking.getByRole('link', { name, exact: true });
    // Each attempt leaves the nav and enters it again, so a fresh pointerenter reopens a menu that closed.
    await expect(async () => {
      await page.mouse.move(0, 0);
      await banking.hover({ timeout: ATTEMPT_MS });
      await expect(target).toBeVisible({ timeout: ATTEMPT_MS });
    }).toPass({ timeout: OPEN_BUDGET_MS });
    const href = (await target.getAttribute('href')) ?? '';
    await page.mouse.move(0, 0);
    await waitForRoute(page, href);
    await expect(async () => {
      await page.mouse.move(0, 0);
      await banking.hover({ timeout: ATTEMPT_MS });
      await target.click({ timeout: ATTEMPT_MS });
    }).toPass({ timeout: OPEN_BUDGET_MS });
    await waitForClickNavigation(page, path, href);
    await expect(page).toHaveURL(path);
  });

  test(`Banking top-nav, opened by click → ${name}`, async ({ page }) => {
    await openWithNav(page, '/accounting');
    const banking = page.locator('[data-tour="nav-banking"]');
    const button = banking.getByRole('button', { name: /banking/i });
    const target = banking.getByRole('link', { name, exact: true });
    // The chevron toggles: click it only while the menu is closed, so a retry cannot close what it just opened.
    const openMenu = async () => {
      if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click({ timeout: ATTEMPT_MS });
      await expect(target).toBeVisible({ timeout: ATTEMPT_MS });
    };
    await expect(openMenu).toPass({ timeout: OPEN_BUDGET_MS });
    const href = (await target.getAttribute('href')) ?? '';
    await waitForRoute(page, href);
    await expect(async () => {
      await openMenu();
      await target.click({ timeout: ATTEMPT_MS });
    }).toPass({ timeout: OPEN_BUDGET_MS });
    await waitForClickNavigation(page, path, href);
    await expect(page).toHaveURL(path);
  });
}
