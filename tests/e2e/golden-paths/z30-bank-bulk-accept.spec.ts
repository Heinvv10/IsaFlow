// golden:dev-only
/**
 * Golden path z30 (WP6): bulk accept of high-confidence suggestions - preview, confirm, undo batch.
 *
 * Seeds three imported lines and a suggest-only rule over them, runs the categoriser so each carries a 0.95 suggestion,
 * then drives the page: the "Accept N high-confidence suggestions" button opens the preview (rows, totals), Confirm posts
 * the batch, the result says "Posted 3", Undo batch reverses exactly that batch and the lines are back to imported.
 *
 * Sandbox only (the z12 pattern): everything runs in the dedicated "0GP Golden Bank Bulk Accept Sandbox" company, found by
 * name and created once through onboarding, never Demo or a real company. It writes a rule, statement lines and one batch
 * (undone again), and Confirm posts every high-confidence line of the account, so the spec skips when the sandbox account
 * already holds a suggestion, and deletes its lines and rule after.
 * Dev-only: a sandbox company and writes, so the post-deploy run against production never loads it (a red production run
 * rolls the deploy back). BANK_TX_EVIDENCE_DIR=<dir> saves a screenshot of the preview.
 */
import { expect, request as pwRequest, test } from '@playwright/test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { Api, gpRef, today } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';

const SANDBOX_NAME = '0GP Golden Bank Bulk Accept Sandbox';
const SANDBOX_ONBOARDING_ID = '5d8e1a3c-7b24-4f69-9a0e-3c6b2d1f8e57';
/** The dialog's name once Confirm has answered: the title changes, so the preview's locator ("Accept 3 ...") no longer finds it. */
const RESULT_TITLE = 'High-confidence suggestions: result';

const t0 = Date.now();
/** One line per step with the seconds since the start, written at once: the job log shows how far a run got even if a later step hangs. */
const step = (what: string) => console.log(`[z30 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}`);

const NIL_ID = '00000000-0000-0000-0000-000000000000';
const PAGE = '/accounting/bank-transactions';
// Every route the page asks for while it is open (the shell, the page's mount reads and panels, the bulk-accept route
// the count, preview, confirm and undo share). GET only: a POST-only route answers 405, which is enough to compile it.
const WARM_APIS = [
  '/api/auth/me', `/api/accounting/companies?id=${NIL_ID}`, '/api/features/check?code=budgets_three_way', '/api/announcements/active',
  '/api/accounting/notifications', '/api/track/event', '/api/auth/preferences', '/api/accounting/accounting-settings?key=enable_cost_centres',
  '/api/accounting/bank-account-summaries', `/api/accounting/bank-transactions?bank_account_id=${NIL_ID}&status=imported`,
  '/api/accounting/chart-of-accounts', '/api/accounting/customers', '/api/accounting/cost-centres?active=true',
  '/api/accounting/suppliers-list?limit=1&page=1', '/api/accounting/bank-relink-transfers', '/api/accounting/bank-auto-post',
  '/api/accounting/coding-metrics', `/api/accounting/bank-transfer-links?bankAccountId=${NIL_ID}`,
  `/api/accounting/bank-bulk-accept?bankAccountId=${NIL_ID}`,
];

/**
 * `next dev` compiles a route on its first request and then tells every open page to do a full reload (see z13 and y1).
 * Each hosted chunk piece starts a fresh dev server, so the page and its panels' routes may be cold when z30 opens it.
 * Requesting them once before any page is open makes every compile happen with no page to reload.
 */
test.beforeAll(async () => {
  test.setTimeout(300_000); // up to twenty cold compiles: longer than the config's 90 s test timeout
  const { baseURL, storageState } = test.info().project.use;
  if (!storageState) throw new Error('z30 warm-up needs the golden session (use.storageState); refusing to warm up unauthenticated');
  const ctx = await pwRequest.newContext({ baseURL, storageState });
  try {
    // No redirects: a stale session would 302 to /login and must fail here, not be mistaken for a warm route.
    const page = await ctx.get(PAGE, { timeout: 120_000, maxRedirects: 0 });
    expect(page.status(), `warm-up ${PAGE} (a 3xx means the session is not valid)`).toBe(200);
    // Only the page must answer 200. A route is warmed by any answer: a 5xx or a timeout here is logged, not a failure (the
    // test itself then meets the route and says what is wrong).
    for (const path of WARM_APIS) {
      const status = await ctx.get(path, { timeout: 120_000, maxRedirects: 0 }).then((r) => r.status(), (err: unknown) => String(err).split('\n')[0]);
      if (typeof status !== 'number' || status >= 500) {
        step(`warm-up ${path}: ${status} (not fatal)`);
        test.info().annotations.push({ type: 'warm-up', description: `${path}: ${status}` });
      }
    }
  } finally {
    await ctx.dispose();
  }
});

/** A cleanup step that cannot hold the run up: bounded, and it says which one hung. True when it finished. */
async function bounded(name: string, work: () => Promise<unknown>, ms = 20_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${name} did not finish within ${ms / 1000}s`)), ms); })]);
    step(`cleanup ${name}: done`);
    return true;
  } catch (err) {
    step(`cleanup ${name}: FAILED ${String(err).split('\n')[0]}`);
    test.info().annotations.push({ type: 'cleanup-failed', description: `${name}: ${String(err)}` });
    return false;
  } finally { if (timer) clearTimeout(timer); }
}

test.setTimeout(420_000); // the dump below must always get to print: the budget is never what ends a failing run

test('bulk accept: preview, confirm, undo batch', async ({ baseURL, page, context }) => {
  const api = await Api.login(baseURL!);
  const sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  const ref = gpRef('BULK');
  const d = today().replace(/-/g, '/');
  let bankAccountId = '';
  let ruleId = '';
  let ids: string[] = [];
  let runId = '';
  let undone = false;
  try {
    step('start: logging in done, finding the sandbox bank account');
    const banks = await api.get<Array<{ id: string }>>('/api/accounting/bank-accounts');
    expect(banks.length, 'company must have a bank account').toBeGreaterThan(0);
    bankAccountId = banks[0]!.id;
    const expense = await api.get<Array<{ id: string; isSystemAccount?: boolean }>>('/api/accounting/chart-of-accounts?subtype=default_expense');
    const expenseId = expense.find((a) => a.isSystemAccount === true)?.id ?? expense[0]?.id;
    expect(expenseId, 'a default expense account').toBeTruthy();

    const before = await api.get<{ lines: unknown[]; scanTruncated: boolean }>(`/api/accounting/bank-bulk-accept?bankAccountId=${bankAccountId}`);
    test.skip(before.lines.length > 0 || before.scanTruncated, 'the account already holds (or may hold) high-confidence suggestions: a confirm would post them too');

    // Descriptions carry no merchant word ("fuel", "coffee"): the global learned patterns would suggest them at import, and the
    // rule's suggestion is only written to a line that has none.
    const csv = ['Date,Description,Amount,Balance,Reference',
      `${d},${ref} zq one,-110.00,9890.00,${ref}-1`,
      `${d},${ref} zq two,-220.00,9670.00,${ref}-2`,
      `${d},${ref} zq three,-330.00,9340.00,${ref}-3`].join('\n');
    await api.post('/api/accounting/bank-transactions-bulk-commit', {
      bankAccountId, bulkImportId: randomUUID(), bulkSequence: 1, filename: `${ref}.csv`, fileType: 'csv',
      statementDate: today(), csvContent: csv, bankFormat: 'fnb', applyBankRules: false,
    });
    const found = await api.get<{ transactions: Array<{ id: string }> }>(
      `/api/accounting/bank-transactions?bank_account_id=${bankAccountId}&status=imported&search=${encodeURIComponent(ref)}`);
    ids = found.transactions.map((t) => t.id);
    expect(ids).toHaveLength(3);

    const rule = await api.post<{ id?: string; rule?: { id: string } }>('/api/accounting/bank-rules', {
      ruleName: `${ref} zq`, matchField: 'description', matchType: 'contains', matchPattern: ref, glAccountId: expenseId, autoCreateEntry: false,
    });
    ruleId = rule.id ?? rule.rule?.id ?? '';
    const categorised = await api.post<{ categorized?: number; results?: unknown[] }>('/api/accounting/smart-categorize', { transactionIds: ids });

    // The API half first, so a failure names its cause (no suggestion written, a line left out, a refused preview) instead of
    // "the button never appeared": the three lines must carry the rule's suggestion and the preview must list them.
    const suggested = await api.get<{ transactions: Array<{ id: string; suggestedGlAccountId?: string | null; suggestedConfidence?: number | null }> }>(
      `/api/accounting/bank-transactions?bank_account_id=${bankAccountId}&status=imported&search=${encodeURIComponent(ref)}`);
    expect(suggested.transactions.filter((t) => t.suggestedGlAccountId && (t.suggestedConfidence ?? 0) >= 0.9).length,
      `the categoriser must suggest all three lines (rule ${ruleId || '?'}, answer ${JSON.stringify(categorised)}, lines ${JSON.stringify(suggested.transactions)})`).toBe(3);
    const apiPreview = await api.get<{ lines: unknown[]; excluded: unknown; needsAttention: unknown[]; scanTruncated: boolean }>(
      `/api/accounting/bank-bulk-accept?bankAccountId=${bankAccountId}`);
    expect(apiPreview.lines, `the preview must list the three lines (excluded ${JSON.stringify(apiPreview.excluded)}, held ${JSON.stringify(apiPreview.needsAttention)}, truncated ${apiPreview.scanTruncated})`).toHaveLength(3);

    // The page: the button names the count, the preview lists the three lines and their totals.
    step('seeded: 3 lines, rule, suggestions; opening the page');
    await page.setViewportSize({ width: 1568, height: 1000 });
    page.setDefaultTimeout(45_000); // no page action may wait out the whole test: each one ends in its own error
    page.setDefaultNavigationTimeout(60_000);
    // Everything the browser says from here on, so a failure after Confirm can be read off the report.
    const consoleErrors: string[] = [];
    const requests: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
    page.on('request', (r) => { if (r.url().includes('/api/')) requests.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
    // A fresh page mount after Confirm (the dialog gone, the page's mount requests again) is a NAVIGATION: record every one, with
    // who asked for it (the request that preceded it), and crashes and closes.
    const navigations: string[] = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) { navigations.push(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${f.url().replace(/^https?:\/\/[^/]+/, '')}`); step(`NAVIGATED ${f.url()}`); } });
    page.on('crash', () => { navigations.push('PAGE CRASHED'); step('PAGE CRASHED'); });
    page.on('close', () => step('PAGE CLOSED'));
    page.on('domcontentloaded', () => step('domcontentloaded (a document was loaded)'));
    page.on('response', (r) => { if (r.request().resourceType() === 'document') step(`document ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
    page.on('requestfailed', (r) => requests.push(`FAILED ${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}: ${r.failure()?.errorText}`));
    const countRead = page.waitForResponse((r) => r.url().includes('/api/accounting/bank-bulk-accept') && r.request().method() === 'GET', { timeout: 90_000 });
    await page.goto(`/accounting/bank-transactions?account_id=${bankAccountId}`);
    const read = await countRead;
    expect(read.status(), `the page's count read answered ${read.status()} for ${read.url()}`).toBe(200);
    expect(read.url(), 'the page must read the count for the seeded account').toContain(bankAccountId);
    step('page count read answered');
    const button = page.getByRole('button', { name: /high-confidence suggestion/ });
    await expect(button).toBeVisible({ timeout: 60_000 });
    await expect(button).toHaveText(/Accept 3\+? high-confidence suggestions/);
    await button.click();
    const dialog = page.getByRole('dialog', { name: /Accept 3 high-confidence suggestions/ });
    await expect(dialog).toBeVisible();
    for (const n of ['one', 'two', 'three']) await expect(dialog.getByText(`${ref} zq ${n}`)).toBeVisible();
    await expect(dialog.getByTestId('bulk-totals')).toContainText(/Total out.*660/);
    if (process.env.BANK_TX_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.BANK_TX_EVIDENCE_DIR, 'bulk-accept-preview.png') });

    // Confirm posts the batch. Every wait here is short and ends in a dump, so a failure is read, not timed out.
    step('preview shown; clicking Confirm');
    const confirmButton = dialog.getByRole('button', { name: /Confirm and post 3/ });
    const dump = async (what: string) => `[z30 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}\n  Confirm: enabled=${await confirmButton.isEnabled().catch(() => '?')} visible=${await confirmButton.isVisible().catch(() => '?')}`
      + `\n  dialog alert: ${await dialog.getByRole('alert').allTextContents().then((t) => t.join(' | ')).catch(() => '?')}`
      + `\n  dialog present: ${await dialog.count().catch(() => '?')}; text: ${(await dialog.textContent({ timeout: 2_000 }).catch(() => '(none within 2s)'))?.slice(0, 500)}`
      + `\n  dialogs on screen (by name): ${await page.locator('[role="dialog"]').evaluateAll((els) => els.map((e) => `"${e.getAttribute('aria-label')}": ${(e.textContent ?? '').slice(0, 200)}`).join(' || ')).catch(() => '?') || '(none)'}`
      + `\n  console: ${consoleErrors.slice(-8).join(' || ') || '(none)'}`
      + `\n  navigations: ${navigations.join(' | ') || '(none)'}`
      + `\n  api requests: ${requests.slice(-14).join(' | ')}`;
    const postSeen = page.waitForRequest((r) => r.url().includes('/api/accounting/bank-bulk-accept') && r.method() === 'POST', { timeout: 20_000 }).catch(() => null);
    try { await confirmButton.click({ timeout: 15_000 }); } catch (err) { { const d = await dump(`Confirm could not be clicked: ${String(err).split('\n')[0]}`); console.log(d); throw new Error(d); } }
    const req = await postSeen;
    if (!req) { const d = await dump('Confirm was clicked but NO POST to bank-bulk-accept was sent within 20 s'); console.log(d); throw new Error(d); }
    const confirmRes = await req.response().then((r) => r, () => null) ?? await page.waitForResponse((r) => r.request() === req, { timeout: 40_000 }).catch(() => null);
    if (!confirmRes) { const d = await dump(`the confirm POST was sent (Idempotency-Key ${req.headers()['idempotency-key'] ?? 'MISSING'}) but no answer came within 40 s`); console.log(d); throw new Error(d); }
    step(`confirm POST answered ${confirmRes.status()}`);
    const confirmText = await confirmRes.text().catch(() => '(unreadable)');
    const confirmKey = req.headers()['idempotency-key'];
    try { runId = JSON.parse(confirmText)?.data?.runId ?? ''; } catch { runId = ''; }
    const result = page.getByRole('dialog', { name: RESULT_TITLE });
    try {
      await expect(result.getByTestId('bulk-result')).toContainText('Posted 3 lines', { timeout: 30_000 });
    } catch (err) {
      const d = await dump(`the result screen did not show "Posted 3 lines": confirm POST answered ${confirmRes.status()} (Idempotency-Key ${confirmKey ?? 'MISSING'}) body ${confirmText.slice(0, 600)}\n${String(err).split('\n')[0]}`);
      console.log(d);
      throw new Error(d);
    }
    step('result screen shown');
    const withStatus = async (status: string) => (await api.get<{ transactions: Array<{ id: string }> }>(
      `/api/accounting/bank-transactions?bank_account_id=${bankAccountId}&status=${status}&search=${encodeURIComponent(ref)}`)).transactions.length;
    expect(await withStatus('allocated'), 'the three lines are allocated after Confirm').toBe(3);

    // Undo batch reverses exactly that batch: the lines are imported again.
    await result.getByRole('button', { name: 'Undo batch' }).click();
    await expect(result.getByText(/Batch undone: 3 lines reversed/)).toBeVisible({ timeout: 60_000 });
    undone = true;
    await result.getByRole('button', { name: 'Done' }).click();
    await expect(result).toHaveCount(0);
    expect(await withStatus('imported')).toBe(3);
    expect(await withStatus('allocated')).toBe(0);
  } finally {
    // Each cleanup step is bounded (20 s) and logged, so a hung request can never run the test out of time.
    step('cleanup begins');
    // A failed expect after Confirm must not leave the batch posted: undo it here whenever a run was seen.
    const undoneNow = runId && !undone ? await bounded('undo batch', () => api.post('/api/accounting/bank-bulk-accept', { action: 'undo', runId })) : true;
    if (!undoneNow) {
      // The batch may still be posted: deleting its lines now would fail or orphan the journals. Leave them for a person.
      step(`cleanup delete lines: SKIPPED (batch ${runId} may still be posted)`);
      test.info().annotations.push({ type: 'cleanup-skipped', description: `lines ${ids.join(', ')} of batch ${runId} left in the sandbox: the undo did not finish` });
    } else if (ids.length > 0) await bounded('delete lines', () => api.post('/api/accounting/bank-transactions-action', { action: 'delete', bankTransactionIds: ids }));
    if (ruleId) await bounded('delete rule', () => api.post('/api/accounting/bank-rules-action', { action: 'delete', id: ruleId }));
    await bounded('dispose', () => api.dispose(), 10_000);
  }
});
