// golden:dev-only
/**
 * Golden path (z34): Company Settings knows when it has unsaved changes (master plan wave 7, UX7: W3, W4).
 *
 *  - Untouched, Save is disabled and reads "No changes".
 *  - Editing a field enables it ("Save Changes"); saving returns it to disabled; editing back to the saved value is clean.
 *  - Leaving the page with unsaved edits opens a "Leave without saving?" dialog (an aria-modal alertdialog): Escape stays,
 *    focus returns to the control that had it, and "Leave" goes on to the page asked for.
 *  - axe reports 0 critical and 0 serious on the settings page and with the dialog open, in both themes.
 *  - EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it saves the phone number of its own sandbox company (never Demo) and runs axe.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX = { name: '0GP Golden Settings Sandbox', onboardingId: '5d2b9c7e-3a16-4f8d-b0e4-7c1a9d3f6b28' };
const PHONE = '#details-tab-phone';

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

for (const theme of THEMES) {
  test(`Save follows the form's dirty state and leaving with edits asks first (${theme})`, async ({ page, context, baseURL }) => {
    const u = new URL(baseURL!);
    expect(u.hostname === 'localhost' && u.port !== '3101', `z34 saves a sandbox company: dev/CI localhost only, not ${u.host}`).toBe(true);
    const api = await Api.login(baseURL!);
    try {
      const sandboxId = await findOrCreateSandbox(api, SANDBOX);
      await switchApiCompany(api, sandboxId);
      await switchBrowserCompany(context, sandboxId);
    } finally {
      await api.dispose();
    }
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => window.addEventListener('unhandledrejection', (e) => ((window as unknown as { __rej: string[] }).__rej ??= []).push(String(e.reason))));
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/accounting/company-settings', { waitUntil: 'domcontentloaded' });
    const save = page.getByRole('button', { name: /Save Changes|No changes/ });
    await expect(page.locator(PHONE)).toBeVisible({ timeout: 60_000 });
    await settle(page);

    await expect(save).toBeDisabled();
    await expect(save).toHaveText('No changes');
    expect(await seriousAxe(page)).toEqual([]);
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/settings-clean-${theme}.png` });

    const original = await page.locator(PHONE).inputValue();
    const edited = original === '0110000034' ? '0110000035' : '0110000034';
    await page.locator(PHONE).fill(edited);
    await expect(save).toBeEnabled();
    await expect(save).toHaveText('Save Changes');
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/settings-dirty-${theme}.png` });

    await save.click();
    await expect(page.getByText(/saved/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(save).toBeDisabled();
    await expect(save).toHaveText('No changes');
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/settings-saved-${theme}.png` });

    await page.locator(PHONE).fill(original);
    await expect(save).toBeEnabled();
    await page.locator(PHONE).fill(edited);
    await expect(save).toBeDisabled();

    await page.locator(PHONE).fill('0110000099');
    await page.getByRole('link', { name: 'Dashboard' }).first().click();
    const dialog = page.getByRole('alertdialog', { name: 'Leave without saving?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(await seriousAxe(page)).toEqual([]);
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/settings-leave-dialog-${theme}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/company-settings/);
    await expect(page.locator(PHONE)).toHaveValue('0110000099');

    await page.getByRole('link', { name: 'Dashboard' }).first().click();
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Leave' }).click();
    await expect(page).not.toHaveURL(/company-settings/, { timeout: 30_000 });
    expect(errors, 'the leave guard raised no page error').toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __rej?: string[] }).__rej ?? []), 'no unhandled rejection').toEqual([]);
  });
}
