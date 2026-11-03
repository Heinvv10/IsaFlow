/**
 * Golden path Z2b - a change the invoice editor's autosave is HOLDING (master plan wave 3, PR S; moved out of z2).
 *
 * A held change (a line autosave will not store) is never sent as the page goes, so Back, Forward and a jump ask.
 * Stay returns to the edit page (navigation.traverseTo) with the change and history in order; Leave goes, sending
 * nothing. The PDF preview refreshing after saves adds no history entry, so a jump lands where it was aimed.
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

test('the PDF preview refreshing (two saves) adds no history entry: a held change and history.go(-2) asks once; Stay returns with the change', async ({ page, context, baseURL }) => {
  const { api, customerId } = await sandbox(context, baseURL!);
  const id = await draft(api, customerId, `Z2b preview ${Date.now().toString(36)}`);
  const ready = () => page.waitForFunction(() => Boolean((window as unknown as { next?: { router?: { isReady?: boolean } } }).next?.router?.isReady), undefined, { timeout: 60_000 });
  const push = (url: string) => page.evaluate((u) => (window as unknown as { next: { router: { push: (u: string) => Promise<boolean> } } }).next.router.push(u), url);
  const edit = new RegExp(`/edit/${id}$`);
  try {
    await page.goto(`/accounting/customer-invoices/${id}?v=0`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: /^edit$/i })).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await ready();
    await push(`/accounting/customer-invoices/${id}?v=1`);
    await push(`/accounting/customer-invoices/edit/${id}`);
    await expect(page.getByPlaceholder('Item description').first()).not.toHaveValue('', { timeout: 60_000 });
    const preview = page.getByTitle('Invoice PDF preview');
    if (!(await preview.isVisible())) await page.getByRole('button', { name: 'Preview PDF' }).click();
    await expect(preview).toHaveAttribute('src', /^blob:/, { timeout: 60_000 });
    for (const n of [1, 2]) { // two saves, each refreshing the preview
      const before = await preview.getAttribute('src');
      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/accounting/customer-invoices-detail'), { timeout: 15_000 });
      await page.getByPlaceholder('Item description').first().fill(`Z2b preview save ${n} ${Date.now().toString(36)}`);
      expect((await saved).status()).toBe(200);
      await expect.poll(() => preview.getAttribute('src'), { timeout: 30_000 }).not.toBe(before);
    }
    await page.getByLabel('Quantity').first().fill('0'); // held
    await expect(page.getByText(/Not saved:/)).toBeVisible({ timeout: 10_000 });
    const asked: string[] = [];
    page.on('dialog', async (d) => { asked.push(d.message()); await d.dismiss(); }); // Stay
    await page.evaluate(() => window.history.go(-2)); // two top-level entries back: only if the preview added none
    await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(1);
    await expect(page).toHaveURL(edit, { timeout: 10_000 });
    await expect(page.getByLabel('Quantity').first()).toHaveValue('0');
    await page.waitForTimeout(1_000);
    expect(asked).toHaveLength(1); // asked once, not again by Stay's own return
  } finally {
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'cancel' });
  }
});
