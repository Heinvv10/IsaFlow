/**
 * PRD-02 Phase 3 — Payroll golden-path smoke test.
 *
 * Walk-through:
 *  1. Map the 7 GL accounts on /payroll/settings and save.
 *  2. Open the first payroll run from /payroll/runs.
 *  3. Calculate if draft, Approve if calculated.
 *  4. Verify the "View in GL →" link appears (journal posted).
 *  5. Click the first Payslip link and verify application/pdf content-type.
 *
 * Auth: uses storageState from auth.setup.ts (chromium project dependency).
 * Run with: bunx playwright test tests/e2e/payroll-phase3-smoke.spec.ts --config playwright-test.config.ts
 */
import { test, expect } from '@playwright/test';

test.describe('PRD-02 Phase 3 — run finalisation', () => {
  test('map GL, approve, see View in GL, download payslip', async ({ page, context }) => {
    // ── 1. Map GL accounts ───────────────────────────────────────────────────
    await page.goto('/payroll/settings');
    await page.waitForLoadState('networkidle');

    // Wait until at least one non-placeholder option is in the first select
    const firstSelect = page.locator('select').first();
    await expect(firstSelect).toBeVisible();
    await page.waitForFunction(
      () => {
        const sel = document.querySelector('select');
        return (sel?.options.length ?? 0) > 1;
      },
      { timeout: 10_000 },
    );

    // Select the 2nd option (index 1) for every role select — index 0 is "— none —"
    const selects = page.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      await selects.nth(i).selectOption({ index: 1 });
    }

    // Save button text matches exactly what the page renders: "Save mappings"
    await page.getByRole('button', { name: 'Save mappings' }).click();

    // Success message is a teal div containing "Saved."
    await expect(page.locator('text=Saved.')).toBeVisible({ timeout: 10_000 });

    // ── 2. Navigate to runs list, open the first one ─────────────────────────
    await page.goto('/payroll/runs');
    await page.waitForLoadState('networkidle');

    const viewLinks = page.locator('a:has-text("View")');
    const linkCount = await viewLinks.count();
    if (linkCount === 0) {
      test.skip(true, 'No payroll runs in fixture DB — run the Phase 2 smoke first to create one.');
    }
    await viewLinks.first().click();
    await expect(page).toHaveURL(/\/payroll\/runs\/[0-9a-f-]{36}/, { timeout: 10_000 });

    // ── 3. Calculate if draft, Approve if calculated ─────────────────────────
    // StatusBadge renders a <span> whose full text content is one of the five
    // status words.  Use a tighter locator scoped to the header div.
    const header = page.locator('div.border-b').first();
    const badge = header.locator('span', {
      hasText: /^(draft|calculated|approved|paid|cancelled)$/,
    }).first();

    await expect(badge).toBeVisible({ timeout: 10_000 });
    let status = (await badge.textContent() ?? '').trim();

    if (status === 'draft') {
      // Phase 2 smoke already tested Calculate; re-calculate here to advance state
      await page.getByRole('button', { name: /^Calculate$/ }).click();
      await expect(badge).toHaveText('calculated', { timeout: 20_000 });
      status = 'calculated';
    }

    if (status === 'calculated') {
      await page.getByRole('button', { name: 'Approve' }).click();
      await expect(badge).toHaveText('approved', { timeout: 20_000 });
    } else if (status !== 'approved') {
      test.skip(true, `Run is in status "${status}" — cannot approve from this state.`);
    }

    // ── 4. "View in GL →" link must be present after approval ────────────────
    // The link renders only when postedJournalEntryId is non-null (set by approve action).
    await expect(page.locator('a:has-text("View in GL")')).toBeVisible({ timeout: 10_000 });

    // ── 5. Payslip download — verify application/pdf via popup response ───────
    // The Payslip <a> opens with target="_blank" which Playwright surfaces as a
    // new context page event.
    const payslipLink = page.locator('a:has-text("Payslip")').first();
    await expect(payslipLink).toBeVisible();

    const popupPromise = context.waitForEvent('page');
    await payslipLink.click();
    const popup = await popupPromise;

    const response = await popup.waitForResponse(
      r => r.url().includes('/payslip/'),
      { timeout: 10_000 },
    );
    expect(response.headers()['content-type']).toContain('application/pdf');
  });
});
