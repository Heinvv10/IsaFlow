/**
 * Golden path (n): accessibility of each golden path's main screen.
 *
 * Specs a-l drive the API, so they never render the screens they cover. This one opens each of those screens in
 * the shared golden session and runs axe-core: any serious/critical violation not listed in a11y-baseline.json
 * fails. Read-only (navigation only); it writes nothing to the company.
 */
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, openScreen } from './helpers/axe';
import { A11Y_SCREENS } from './helpers/a11yScreens';

for (const screen of A11Y_SCREENS) {
  test(`a11y: ${screen.name} (${screen.path})`, async ({ page }) => {
    await openScreen(page, screen);
    await expectNoSeriousA11yViolations(page);
  });
}

test('the gate is not vacuous: an unlabelled input injected into a screen fails it', async ({ page }) => {
  await openScreen(page, A11Y_SCREENS.find((s) => s.path === '/accounting/credit-notes')!);
  await expectNoSeriousA11yViolations(page); // green before the injection
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'injected-unlabelled-input';
    document.body.appendChild(input);
  });
  // The post-deploy check runs the suite with A11Y_GATE=report; this test is about the enforcing gate.
  const outer = process.env.A11Y_GATE;
  process.env.A11Y_GATE = 'enforce';
  let failure: string | null;
  try {
    failure = await expectNoSeriousA11yViolations(page).then(() => null, (e: Error) => e.message);
  } finally {
    if (outer === undefined) delete process.env.A11Y_GATE; else process.env.A11Y_GATE = outer;
  }
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
