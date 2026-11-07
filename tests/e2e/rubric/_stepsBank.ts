/**
 * Rubric M9 on the bank transactions page (master plan wave 4, MW): exclude the imported spend line and Undo it from
 * the toast by keyboard; allocate the line that equals the open invoice and record what Undo does there. Sandbox only.
 * Both lines are put back to `imported` afterwards, so a re-run with the same run id measures the same thing.
 */
import { expect, type Page } from '@playwright/test';
import type { Api } from '../golden-paths/_api';
import { Tally, type Evidence, type StepRecord } from './_rubricEvidence';
import { bankLine, type Seeded } from './_rubricSeed';
import { chooseOption, isFocused, loadedOrReload } from './_rubricUi';

const ROWS = '[data-testid="bank-tx-table"] tbody tr';
const ACTION = '/api/accounting/bank-transactions-action';

async function restoreImported(api: Api, seed: Seeded, ref: string): Promise<string> {
  const line = await bankLine(api, seed.bankAccountId, ref);
  if (!line) throw new Error(`the seeded line ${ref} is missing`);
  if (line.status === 'excluded') await api.post(ACTION, { action: 'unmatch', bankTransactionId: line.id, expectedStatus: 'excluded' });
  else if (line.status !== 'imported') await api.post(ACTION, { action: 'reverse', bankTransactionId: line.id });
  return line.id;
}

async function openBank(page: Page, seed: Seeded, ref: string) {
  await page.goto(`/accounting/bank-transactions?account_id=${seed.bankAccountId}`, { waitUntil: 'domcontentloaded' });
  const row = page.locator(ROWS, { hasText: ref });
  await loadedOrReload(page, row);
  return row;
}

/** M9 exclude: the Undo toast is a status region, Tab reaches its button, and Undo puts the line back at `imported`. */
export async function measureM9Exclude(page: Page, ev: Evidence, api: Api, seed: Seeded): Promise<StepRecord> {
  const ref = seed.bankRefs.spend;
  const id = await restoreImported(api, seed, ref);
  const row = await openBank(page, seed, ref);
  const tally = new Tally(page);
  await tally.click(row.getByRole('button', { name: /^Exclude, / }));
  await tally.click(page.getByRole('button', { name: 'Duplicate', exact: true }));
  await tally.click(page.getByRole('button', { name: 'Exclude Transaction' }));
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeVisible({ timeout: 30_000 });
  expect((await bankLine(api, seed.bankAccountId, ref))?.status).toBe('excluded');
  const toastIsStatus = await page.getByRole('status').filter({ has: undo }).count() > 0;
  const screenshot = await ev.shot(page, 'm9-exclude-undo-toast');

  let tabsToUndo: number | null = null;
  for (let i = 1; i <= 60; i++) {
    await tally.press('Tab');
    if (await isFocused(undo)) { tabsToUndo = i; break; }
  }
  if (tabsToUndo !== null) await tally.press('Enter');
  else await tally.click(undo);
  await expect(page.getByText('Transaction restored')).toBeVisible({ timeout: 30_000 });
  const after = await bankLine(api, seed.bankAccountId, ref);
  return {
    status: 'measured', toastIsStatus, reachableByTab: tabsToUndo !== null, tabsToUndo, undoneBy: tabsToUndo !== null ? 'keyboard' : 'click',
    lineAfterUndo: after?.status, backToImported: after?.id === id && after?.status === 'imported', ...tally.summary(), screenshot,
  };
}

/** M9 allocate: allocate the matching line to the customer, then record whether Undo reversed it or what was shown. */
export async function measureM9Allocate(page: Page, ev: Evidence, api: Api, seed: Seeded): Promise<StepRecord> {
  const ref = seed.bankRefs.matching;
  await restoreImported(api, seed, ref);
  const row = await openBank(page, seed, ref);
  const tally = new Tally(page);
  try {
    await chooseOption(page, row.getByLabel(/^Allocation type, /), /^Customer$/);
    tally.clicks++;
    const trigger = row.getByRole('button', { name: /Choose customer, / });
    await tally.click(trigger);
    await tally.fill(page.getByLabel(/^Search /).last(), seed.customer.name);
    const option = page.locator('[data-bank-dropdown] button', { hasText: seed.customer.name }).first();
    // With few rows the picker opens upward into the table's frame, which clips it: recorded, then measured on a taller window.
    const pickerReachable = await option.click({ trial: true, timeout: 5_000 }).then(() => true, () => false);
    if (!pickerReachable) {
      await page.setViewportSize({ width: 1568, height: 1400 });
      await trigger.click(); // closes it; it decides up or down only as it opens
      await expect(page.locator('[data-bank-dropdown]')).toHaveCount(0);
      await tally.click(trigger);
      await tally.fill(page.getByLabel(/^Search /).last(), seed.customer.name);
    }
    await tally.click(option);
    await tally.click(row.getByRole('button', { name: /^Accept, / }));
    await expect.poll(async () => (await bankLine(api, seed.bankAccountId, ref))?.status, { timeout: 30_000 }).not.toBe('imported');
    const allocatedAs = (await bankLine(api, seed.bankAccountId, ref))?.status;
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const offered = await undo.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false);
    const screenshot = await ev.shot(page, 'm9-allocate-after');
    if (!offered) {
      return {
        status: 'measured', allocatedAs, undo: 'not offered', pickerReachableAt1568x900: pickerReachable,
        note: 'customer lines have no Undo by design (bankTxUndo.ts, wave-3 decision 4)', ...tally.summary(), screenshot,
      };
    }
    await tally.click(undo);
    const outcome = await Promise.race([
      page.getByText('Allocation undone').first().waitFor({ timeout: 30_000 }).then(() => 'reversed'),
      page.getByText(/could not undo|refus|locked|closed/i).first().waitFor({ timeout: 30_000 }).then(() => 'refused'),
    ]);
    const shown = outcome === 'refused' ? (await page.getByText(/could not undo|refus|locked|closed/i).first().textContent())?.trim() : undefined;
    return { status: 'measured', allocatedAs, undo: outcome, pickerReachableAt1568x900: pickerReachable, refusal: shown, lineAfterUndo: (await bankLine(api, seed.bankAccountId, ref))?.status,
      ...tally.summary(), screenshot };
  } finally {
    await page.setViewportSize({ width: 1568, height: 900 });
    await restoreImported(api, seed, ref);
  }
}
