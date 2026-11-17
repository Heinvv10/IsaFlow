// golden:dev-only
/**
 * Golden path (z26): the bank-transactions modals and pager are accessible (WP7 accessibility pass).
 *
 * Read-only on dev data: it OPENS the Exclude and Ask-client dialogs and closes them again; nothing is sent or saved.
 *  - each dialog is a named, modal dialog, axe reports no serious or critical violation inside it (nothing excused),
 *    Tab stays inside it, Escape closes it and focus returns to the button that opened it;
 *  - the pager is a named `nav` and marks the current page with aria-current;
 *  - the selected account card carries a check mark as well as its colour.
 * Dev-only: axe, and it needs rows (and a second page for the pager) in dev's Demo company; every part guards on what exists.
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, seedTheme, settle } from '../helpers/themeSpec';

const BANK = '/accounting/bank-transactions';
const ROWS = '[data-testid="bank-tx-table"] tbody tr';
const NOTHING_EXCUSED = { pages: {} };

test.setTimeout(180_000);

async function openBank(page: Page, theme: (typeof THEMES)[number]) {
  await page.setViewportSize({ width: 1568, height: 1000 });
  await seedTheme(page, theme);
  await page.goto(BANK, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await expect(page.getByTestId('bank-tx-stats-strip').or(page.getByText('No bank accounts configured'))).toBeVisible({ timeout: 45_000 });
}

for (const theme of THEMES) {
  test(`the pager is a named nav with the current page marked, and the selected card has a check (${theme})`, async ({ page }) => {
    await openBank(page, theme);
    if (await page.getByText('No bank accounts configured').count() > 0) return;
    const card = page.getByTestId('card-selected-mark');
    if (await page.getByTestId('bank-account-card').count() > 0 && await page.locator('[data-testid="bank-account-card"][aria-current="true"]').count() > 0) {
      await expect(card.first()).toBeVisible();
    }
    await expect(page.getByTestId('bank-tx-table').or(page.getByTestId('bank-tx-empty'))).toBeVisible({ timeout: 45_000 });
    const nav = page.getByRole('navigation', { name: 'Transaction pages' });
    if (await nav.count() === 0) return; // a single page of lines: no pager
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav.locator('[aria-current="page"]')).toHaveText('1');
  });

  for (const [name, button, dialogName] of [
    ['Exclude', /^Exclude, /, 'Exclude transaction'],
    ['Ask client', /^(Ask client|Client already asked) on WhatsApp, /, 'Ask the client'],
  ] as const) {
    test(`${name} dialog: named, axe clean, Tab stays inside, Escape closes and returns focus (${theme})`, async ({ page }) => {
      await openBank(page, theme);
      await expect(page.getByTestId('bank-tx-table').or(page.getByTestId('bank-tx-empty'))).toBeVisible({ timeout: 45_000 });
      const trigger = page.locator(ROWS).getByRole('button', { name: button }).first();
      if (await trigger.count() === 0) return; // no such line on this account's New tab
      await trigger.focus();
      await trigger.press('Enter');
      const dialog = page.getByRole('dialog', { name: dialogName });
      await expect(dialog).toBeVisible();
      await settle(page);
      await expectNoSeriousA11yViolations(page, { include: ['[role="dialog"][aria-label="' + dialogName + '"]'], key: 'bank-transactions#modal', baseline: NOTHING_EXCUSED });
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `Tab ${i + 1} stays in the dialog`).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
}
