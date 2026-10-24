/**
 * Golden path (n): accessibility of each golden path's main screen.
 *
 * Specs a-l drive the API, so they never render the screens they cover. This one opens each of those screens in
 * the shared golden session and runs axe-core: any serious/critical violation not listed in a11y-baseline.json
 * fails. Read-only (navigation only); it writes nothing to the company.
 */
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, openScreen, SETUP_GUIDE_BUTTON } from './helpers/axe';
import { A11Y_SCREENS, A11Y_SHELL_KEYS } from './helpers/a11yScreens';

for (const screen of A11Y_SCREENS) {
  test(`a11y: ${screen.name} (${screen.path})`, async ({ page }) => {
    await openScreen(page, screen);
    await expectNoSeriousA11yViolations(page);
  });
}

test('setup guide badge: the shell button, scanned once the state it renders from has loaded', async ({ page }) => {
  // The count badge renders only after both requests resolve and disappears when nothing is left to set up, so
  // it is out of every page scan (SHELL_EXCLUDES) and checked here, where its absence is not a failure.
  const loaded = Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/accounting/setup-guide'), { timeout: 30_000 }),
    page.waitForResponse((r) => r.url().includes('/api/auth/preferences'), { timeout: 30_000 }),
  ]).catch(() => null);
  await openScreen(page, A11Y_SCREENS[0]!);
  await loaded;
  const badge = page.locator(`${SETUP_GUIDE_BUTTON} span`);
  await badge.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => null);
  if ((await badge.count()) === 0) {
    test.info().annotations.push({ type: 'setup-guide-badge-absent', description: 'nothing left to set up (or the guide is hidden): nothing to scan' });
    return;
  }
  await expectNoSeriousA11yViolations(page, { includeShell: true, include: [SETUP_GUIDE_BUTTON], key: A11Y_SHELL_KEYS.setupGuideBadge });
});

/** The two self-tests below are about the ENFORCING gate; the post-deploy run sets A11Y_GATE=report for the suite. */
async function enforcing<T>(fn: () => Promise<T>): Promise<T> {
  const outer = process.env.A11Y_GATE;
  process.env.A11Y_GATE = 'enforce';
  try {
    return await fn();
  } finally {
    if (outer === undefined) delete process.env.A11Y_GATE; else process.env.A11Y_GATE = outer;
  }
}

test('the gate is not vacuous: an unlabelled input injected into a screen fails it', async ({ page }) => {
  const failure = await enforcing(async () => {
    await openScreen(page, A11Y_SCREENS.find((s) => s.path === '/accounting/credit-notes')!);
    await expectNoSeriousA11yViolations(page); // green before the injection
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'injected-unlabelled-input';
      document.body.appendChild(input);
    });
    return expectNoSeriousA11yViolations(page).then(() => null, (e: Error) => e.message);
  });
  expect(failure, 'an unlabelled input must fail the gate').not.toBeNull();
  expect(failure).toContain('label'); // rule id
  expect(failure).toContain('critical'); // impact
  expect(failure).toContain('#injected-unlabelled-input'); // target
});

test('a screen that redirects fails openScreen instead of being scanned under the wrong page', async ({ page }) => {
  // /accounting/journal-entries redirects to the dashboard's journal tab, which has an <h1> of its own.
  const redirected = enforcing(() => openScreen(page, { name: 'redirect probe', path: '/accounting/journal-entries', heading: 'Journal Entries' }));
  await expect(redirected).rejects.toThrow(/expected \/accounting\/journal-entries but the browser is on \/accounting/);
});
