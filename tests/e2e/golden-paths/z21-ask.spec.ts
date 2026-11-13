// golden:dev-only
/**
 * Golden path Z21 (wave 5 M11): "Ask IsaFlow" in the command palette answers with the figure the page shows. READ-ONLY on the
 * golden session's company (the Demo company, or the CI slot's seeded copy), dev only.
 *
 *  - "Who owes me money?" gives the AR aging page's Total card, to the cent, with a link to that page.
 *  - "How much cash is in the bank?" lists each account with the Net Balance its card on the bank accounts page shows.
 *  - Click a payroll line's figure, Ctrl+K, "Explain this figure": that figure's explanation drawer opens.
 *  - A question outside the twelve says so and suggests questions that work.
 *  - The panel passes axe at 1568 and 390, light and dark, with no sideways scroll at 390.
 * ASK_EVIDENCE_DIR=<dir> saves a screenshot per width and theme. Nothing is written.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'path';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, settle } from '../helpers/themeSpec';

const evidenceDir = process.env.ASK_EVIDENCE_DIR;
test.setTimeout(240_000);

/** 'R 1 234.50' or '−R 15.00' in rands. */
const money = (s: string): number => Number(s.replace(/−/g, '-').replace(/[^\d.-]/g, ''));
const DIALOG = '[role="dialog"][aria-label="Command palette"]';

async function ask(page: Page, question: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.getByRole('option', { name: /Ask IsaFlow/ }).click();
  const box = page.getByLabel('Ask IsaFlow a question');
  await expect(box).toBeFocused();
  await box.fill(question);
  await box.press('Enter');
  await expect(page.getByTestId('ask-text')).toBeVisible({ timeout: 60_000 });
}

test('who owes me money equals the AR aging total', async ({ page }) => {
  await page.setViewportSize({ width: 1568, height: 1000 });
  await page.goto('/accounting/ar-aging', { waitUntil: 'domcontentloaded' });
  await settle(page);
  const total = page.getByText('Total', { exact: true }).first().locator('xpath=following-sibling::p');
  await expect(total).toContainText('R', { timeout: 60_000 });
  const shown = money((await total.textContent()) ?? '');

  await ask(page, 'Who owes me money?');
  const answer = (await page.getByTestId('ask-text').textContent()) ?? '';
  const said = money(/R\s?[\d\s]+\.\d{2}/.exec(answer.replace(/ /g, ' '))?.[0] ?? '');
  expect(said, `answer "${answer}" vs page total ${shown}`).toBeCloseTo(shown, 2);
  await expect(page.getByRole('link', { name: 'Open AR aging' })).toHaveAttribute('href', '/accounting/ar-aging');
  console.log(`z21: AR aging page ${shown}, answer ${said}`);
});

test('cash in the bank equals each account card on the bank accounts page', async ({ page }) => {
  await page.setViewportSize({ width: 1568, height: 1000 });
  await page.goto('/accounting/bank-accounts', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await expect(page.getByText('Net Balance').first()).toBeVisible({ timeout: 60_000 });

  await ask(page, 'How much cash is in the bank?');
  const rows = page.getByTestId('ask-answer').locator('li');
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  let checked = 0;
  for (let i = 0; i < n; i++) {
    const [name, amount] = (await rows.nth(i).locator('span').allTextContents()) as [string, string];
    if (name.includes('(inactive') || name.startsWith('Ledger cash')) continue; // the page lists active accounts only, on the statement basis
    const card = page.locator('main').getByText(name, { exact: true }).first().locator('xpath=ancestor::*[.//p[text()="Net Balance"]][1]');
    const shown = money((await card.locator('p.text-2xl').first().textContent()) ?? '');
    expect(money(amount), `${name}`).toBeCloseTo(shown, 2);
    checked++;
  }
  expect(checked, 'no active account to compare').toBeGreaterThan(0);
});

test('click a payroll figure, Ctrl+K, Explain this figure opens its explanation', async ({ page }) => {
  await page.setViewportSize({ width: 1568, height: 1000 });
  const res = await page.request.get('/api/payroll/runs');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { data: unknown };
  const list = (Array.isArray(body.data) ? body.data : ((body.data as { runs?: unknown[] }).runs ?? [])) as Array<{ id: string; status: string }>;
  const run = list.find((r) => r.status === 'approved' || r.status === 'paid');
  expect(run, 'z21 needs an approved or paid pay run in the golden company (the CI slot seeds one); none found, so the Explain step cannot run').toBeTruthy();
  await page.goto(`/payroll/runs/${run!.id}`, { waitUntil: 'domcontentloaded' });
  const cell = page.locator('td[data-explain-scope]').first();
  await expect(cell).toBeVisible({ timeout: 60_000 });
  // Another control has focus first (the common case): the click on the figure's text then blurs it to nothing, and that must not lose the figure.
  await page.getByRole('button').first().focus();
  await cell.click({ position: { x: 4, y: 4 } }); // the figure's own cell, not its button: a click focuses nothing
  await page.keyboard.press('Control+k');
  await page.getByRole('option', { name: /Explain this figure/ }).click();
  await expect(page.getByRole('dialog').filter({ hasText: /was calculated/ })).toBeVisible({ timeout: 30_000 });
});

test('a full question typed into Ctrl+K gets an Ask IsaFlow row, and Enter answers it', async ({ page }) => {
  await page.setViewportSize({ width: 1568, height: 1000 });
  await page.goto('/accounting', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('who owes me money');
  await expect(page.getByRole('option').first()).toContainText('Ask IsaFlow: who owes me money');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ask-text')).toContainText(/customers owe you/i, { timeout: 60_000 });
});

test('an unknown question says so and suggests questions that work; axe clean', async ({ page }) => {
  await page.setViewportSize({ width: 1568, height: 1000 });
  await page.goto('/accounting', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await ask(page, 'What is the weather in Cape Town?');
  await expect(page.getByTestId('ask-text')).toContainText('fixed set of questions');
  await expect(page.getByRole('button', { name: 'Who owes me money?' })).toBeVisible();

  for (const theme of THEMES) {
    for (const width of [1568, 390]) {
      await page.evaluate((t) => window.localStorage.setItem('accounting-theme', t), theme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle(page);
      await ask(page, 'What is the weather in Cape Town?');
      await expect(page.getByRole('button', { name: 'Who owes me money?' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, { key: `z21-ask-${theme}-${width}`, baseline: { pages: {} } });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `page scrolls sideways at ${width}`).toBeLessThanOrEqual(0);
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `ask-${theme}-${width}.png`) });
    }
  }
});
