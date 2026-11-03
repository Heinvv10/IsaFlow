/**
 * Golden path Z2b - a change the invoice editor's autosave is HOLDING (master plan wave 3, PR S; moved out of z2).
 *
 * A held change (a line autosave will not store) is never sent as the page goes, so Back, Forward and a jump ask.
 * Stay returns to the edit page with the change and history in order; Leave goes, sending nothing.
 */
// golden:dev-only
// Dev only: it writes invoices in a sandbox company. The post-deploy run skips it by this marker.
import { expect, test } from '@playwright/test';
import { countPuts, draft, sandbox } from './_invoiceAutosaveFixture';
import { settle } from '../helpers/themeSpec';

test('a change autosave is holding: Forward, Back and a two-step jump ask; Stay undoes each with history order kept; Leave sends nothing', async ({ page, context, baseURL }) => {
  const { api, customerId } = await sandbox(context, baseURL!);
  const id = await draft(api, customerId, `Z2 held back ${Date.now().toString(36)}`);
  const ready = () => page.waitForFunction(() => Boolean((window as unknown as { next?: { router?: { isReady?: boolean } } }).next?.router?.isReady), undefined, { timeout: 60_000 });
  const push = (url: string) => page.evaluate((u) => (window as unknown as { next: { router: { push: (u: string) => Promise<boolean> } } }).next.router.push(u), url);
  const view = (v: string) => `/accounting/customer-invoices/${id}?v=${v}`;
  const edit = new RegExp(`/edit/${id}$`);
  try {
    await page.goto(view('0'), { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: /^edit$/i })).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await ready();
    await push(view('1')); // client-side entries: back/forward between them are popstates
    await push(`/accounting/customer-invoices/edit/${id}`);
    await expect(page.getByPlaceholder('Item description').first()).not.toHaveValue('', { timeout: 60_000 });
    await push(view('2')); // nothing unsaved: goes unasked; a forward entry for later
    await page.goBack();
    await page.waitForURL(edit, { timeout: 30_000 });
    await expect(page.getByPlaceholder('Item description').first()).not.toHaveValue('', { timeout: 60_000 });
    const puts = countPuts(page);
    await page.getByLabel('Quantity').first().fill('0'); // a line autosave will not store: held
    await expect(page.getByText(/Not saved:/)).toBeVisible({ timeout: 10_000 });
    const answers = [false, false, false, true]; // Stay, Stay, Stay, Leave
    const asked: string[] = [];
    page.on('dialog', async (d) => { asked.push(d.message()); await (answers.shift() ? d.accept() : d.dismiss()); });
    // The address moves before the question: wait for the question, then for Stay's history.go to bring it back.
    const stay = async (n: number) => {
      await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(n);
      await expect(page).toHaveURL(edit, { timeout: 10_000 });
      await expect(page.getByLabel('Quantity').first()).toHaveValue('0');
    };
    await page.goForward(); await stay(1);
    await page.goBack(); await stay(2);
    await page.evaluate(() => window.history.go(-2)); await stay(3);
    await page.goBack(); // Leave
    await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(4);
    await page.waitForURL(new RegExp(`\\?v=1$`), { timeout: 30_000 }); // the entry before the edit page: order kept
    expect(puts(), 'a held change is never sent').toBe(0);
    expect((await api.get<{ items: { quantity: number | string }[] }>(`/api/accounting/customer-invoices-detail?id=${id}`)).items.map((i) => Number(i.quantity))).toEqual([1]);
    await page.goForward();
    await page.waitForURL(edit, { timeout: 30_000 });
    await page.goForward(); // the forward entry is still there, after the edit page
    await page.waitForURL(new RegExp(`\\?v=2$`), { timeout: 30_000 });
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});

