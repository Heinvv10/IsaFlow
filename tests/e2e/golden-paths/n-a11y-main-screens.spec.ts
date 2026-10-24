/**
 * Golden path (n): accessibility of each golden path's main screen.
 *
 * Specs a-l drive the API, so they never render the screens they cover. This one opens each of those screens in
 * the shared golden session and runs axe-core: any serious/critical violation not listed in a11y-baseline.json
 * fails. Read-only (navigation only); it writes nothing to the company.
 */
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, waitForScreenReady } from './helpers/axe';
import { A11Y_SCREENS } from './helpers/a11yScreens';

for (const screen of A11Y_SCREENS) {
  test(`a11y: ${screen.name} (${screen.path})`, async ({ page }) => {
    await page.goto(screen.path);
    await waitForScreenReady(page);
    await expectNoSeriousA11yViolations(page);
  });
}

test('the gate is not vacuous: an unlabelled input injected into a screen fails it', async ({ page }) => {
  await page.goto('/accounting/credit-notes');
  await waitForScreenReady(page);
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
