/**
 * Golden path (n): accessibility of each golden path's main screen.
 *
 * Specs a-l drive the API, so they never render the screens they cover. This one opens each of those screens in
 * the shared golden session and runs axe-core: any serious/critical violation not listed in a11y-baseline.json
 * fails. Read-only (navigation only); it writes nothing to the company.
 *
 * A dev/CI gate only: scripts/verify-deploy.sh runs the golden suite against production after a deploy with
 * GOLDEN_SKIP_A11Y=1, which makes playwright-golden.config.ts testIgnore this file (it is never even loaded), because
 * the baseline is keyed to dev data and a red post-deploy run rolls the code back.
 * tests/unit/scripts/verifyDeployA11yGate.test.ts proves it against the real script.
 */
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, expectScreenClean, openScreen, SETUP_GUIDE_BUTTON } from './helpers/axe';
import { A11Y_SCREENS, A11Y_SHELL_KEYS } from './helpers/a11yScreens';

for (const screen of A11Y_SCREENS) {
  test(`a11y: ${screen.name} (${screen.path})`, async ({ page }) => {
    await openScreen(page, screen);
    await expectScreenClean(page, screen);
  });
}

test('setup guide badge: the shell button, scanned once the state it renders from has loaded', async ({ page }) => {
  // The button renders only after /api/accounting/setup-guide and /api/auth/preferences have loaded, and its count
  // badge only while tasks remain: so wait for the BUTTON (which proves the load), then read the count from its own
  // label. No remaining tasks means no badge and nothing to scan; any other count means the badge must be there.
  await openScreen(page, A11Y_SCREENS[0]!);
  const button = page.locator(SETUP_GUIDE_BUTTON);
  await expect(button, 'the Setup-guide button renders once its data has loaded').toBeVisible({ timeout: 30_000 });
  const remaining = Number(/(\d+) tasks? remaining/.exec((await button.getAttribute('aria-label')) ?? '')?.[1]);
  expect(Number.isInteger(remaining), 'the button label names the tasks remaining').toBe(true);
  if (remaining === 0) {
    test.info().annotations.push({ type: 'setup-guide-badge-absent', description: 'nothing left to set up: no badge, nothing to scan' });
    return;
  }
  await expect(button.locator('span'), `${remaining} tasks remaining, so the badge renders`).toBeVisible();
  await expectNoSeriousA11yViolations(page, { includeShell: true, include: [SETUP_GUIDE_BUTTON], key: A11Y_SHELL_KEYS.setupGuideBadge });
});

test('the gate is not vacuous: an unlabelled input injected into a screen fails it', async ({ page }) => {
  await openScreen(page, A11Y_SCREENS.find((s) => s.path === '/accounting/credit-notes')!);
  await expectNoSeriousA11yViolations(page); // green before the injection
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'injected-unlabelled-input';
    document.body.appendChild(input);
  });
  const failure = await expectNoSeriousA11yViolations(page).then(() => null, (e: Error) => e.message);
  expect(failure, 'an unlabelled input must fail the gate').not.toBeNull();
  expect(failure).toContain('label'); // rule id
  expect(failure).toContain('critical'); // impact
  expect(failure).toContain('#injected-unlabelled-input'); // target
});

test('a screen that redirects fails openScreen instead of being scanned under the wrong page', async ({ page }) => {
  // /accounting/journal-entries redirects to the dashboard's journal tab, which has an <h1> of its own.
  const redirected = openScreen(page, { name: 'redirect probe', path: '/accounting/journal-entries', heading: 'Journal Entries' });
  await expect(redirected).rejects.toThrow(/expected \/accounting\/journal-entries but the browser is on \/accounting/);
});
