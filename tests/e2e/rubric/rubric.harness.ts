/**
 * The rubric measurement harness (master plan wave 4, MW): the writes wave 3 could not measure, on dev, in a sandbox
 * company of its own, never on production and never in Demo. Run by playwright-rubric.config.ts only; the file name is
 * not `*.spec.ts` on purpose, so no other Playwright config (several point at production) ever collects it.
 *
 * One test, serial steps. The guard (_rubricGuard.ts, _rubricSession.ts) runs before the first request. Each step
 * records into RUBRIC_EVIDENCE_DIR/rubric.json; a step whose PR has not merged records "not built" and does not fail.
 * The run fails at the end if any step failed or the invoice-email intercept was not hit (or was bypassed).
 */
import { expect, test, type Browser, type BrowserContext } from '@playwright/test';
import type { Api } from '../golden-paths/_api';
import {
  APPROVER_EMAIL, EmailInterceptTally, REQUESTER_EMAIL, assertSession, isEmailRoute, isSwitchCompanyRoute, type MeView,
} from './_rubricGuard';
import { Evidence } from './_rubricEvidence';
import { netPayToBank, seedPayRun, seedSandbox, type Seeded } from './_rubricSeed';
import {
  approverInSandbox, assertWriteScope, checkEnvironment, loadAverage, me, requesterInSandbox, type RubricEnv, type Sandbox,
} from './_rubricSession';
import { measureM9Allocate, measureM9Exclude } from './_stepsBank';
import { measureM4, measureT2 } from './_stepsInvoice';
import { measureM7, measureM8, measureNs1List, measureT7 } from './_stepsLook';
import { measureM5, measureT3, measureT4 } from './_stepsPayroll';

test.setTimeout(45 * 60_000);

/** A browser context carrying `api`'s session, with the email route answered here and every request to it counted. */
async function sandboxContext(browser: Browser, env: RubricEnv, api: Api, email: string, sandbox: Sandbox,
  tally: EmailInterceptTally, blockedSwitches: string[]): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: env.baseURL, storageState: await api.ctx.storageState(), serviceWorkers: 'block', viewport: { width: 1568, height: 900 },
  });
  // A context made here does not take the config's `use` timeouts: bound every action, or a stuck step records nothing.
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(120_000);
  context.on('request', (r) => tally.onRequest(r.url()));
  await context.route((url) => isEmailRoute(url.href), async (route) => {
    tally.onFulfilled();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { sent: true } }) });
  });
  await context.route((url) => isSwitchCompanyRoute(url.href), async (route) => {
    blockedSwitches.push(`${email} at ${new Date().toISOString()} from ${route.request().headers().referer ?? 'unknown page'}`);
    await route.abort('blockedbyclient');
  });
  await guardBrowser(context, email, sandbox);
  return context;
}

async function guardBrowser(context: BrowserContext, email: string, sandbox: Sandbox): Promise<void> {
  const view = ((await (await context.request.get('/api/auth/me')).json()) as { data: MeView }).data;
  assertSession(view, email, sandbox);
}

test('rubric harness: seeded sandbox writes on dev', async ({ browser, baseURL }) => {
  const env = checkEnvironment(baseURL); // throws before any request
  const ev = new Evidence(env.evidenceDir, {
    runId: env.runId, baseURL: env.baseURL, serverDir: env.serverDir, serverHead: env.serverHead,
    startedAt: new Date().toISOString(), uptimeStart: loadAverage(), requester: REQUESTER_EMAIL, approver: APPROVER_EMAIL,
  });
  const { api, sandbox } = await requesterInSandbox(env);
  ev.seed('sandbox', sandbox);
  const seeded = await seedSandbox(env, api, sandbox);
  ev.seed('objects', seeded);
  const approverApi = await approverInSandbox(env, sandbox);
  const ids = { requester: (await me(api)).user.id!, approver: (await me(approverApi)).user.id! };
  ev.seed('r035', {
    approverMembership: seeded.approver, path: 'two-person: requested by the requester, decided by the approver',
    soleApproverException: 'not used', userIds: ids,
  });

  const tally = new EmailInterceptTally();
  const blockedSwitches: string[] = [];
  const context = await sandboxContext(browser, env, api, REQUESTER_EMAIL, sandbox, tally, blockedSwitches);
  const approverContext = await sandboxContext(browser, env, approverApi, APPROVER_EMAIL, sandbox, tally, blockedSwitches);
  const page = await context.newPage();
  const writes = async () => {
    await assertWriteScope(api, REQUESTER_EMAIL, sandbox);
    await guardBrowser(context, REQUESTER_EMAIL, sandbox);
  };

  try {
    await page.goto('/accounting/default-accounts', { waitUntil: 'domcontentloaded' });
    const hasSetting = await page.getByText('Payroll net pay').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    await writes();
    ev.seed('netPay', { ...(await netPayToBank(api, hasSetting)), bankAccountId: seeded.bankAccountId });

    await writes();
    await ev.step('T3 keyboard-only employee create', () => measureT3(page, ev, env.runId), page);
    await writes();
    const seed: Seeded = { ...seeded, run: await seedPayRun(api) };
    ev.seed('payRun', seed.run);
    await writes();
    await ev.step('M4 server autosave', () => measureM4(page, ev, seed), page);
    await writes();
    await ev.step('T2 invoice to Approve & email', () => measureT2(page, ev, api, seed), page);
    await writes();
    await ev.step('M9 exclude and Undo', () => measureM9Exclude(page, ev, api, seed), page);
    await writes();
    await ev.step('M9 allocate and Undo', () => measureM9Allocate(page, ev, api, seed), page);
    await writes();
    await ev.step('M5 grid typing', () => measureM5(page, ev, api, seed), page);
    await writes();
    await guardBrowser(approverContext, APPROVER_EMAIL, sandbox);
    const approverPage = await approverContext.newPage();
    await ev.step('T4 payslip through R-035', () => measureT4(page, approverPage, ev, { requester: api, ids }, seed), page);
    await ev.step('M7 row heights (DG)', () => measureM7(context, seed));
    await ev.step('M8 transition durations', () => measureM8(page, ev), page);
    await ev.step('T7 prior-period comparison', () => measureT7(page, ev), page);
    await ev.step('NS1 invoice list controls', () => measureNs1List(page), page);
  } finally {
    ev.meta('uptimeEnd', loadAverage());
    ev.meta('finishedAt', new Date().toISOString());
    ev.meta('emailIntercept', { requests: tally.seen, fulfilled: tally.fulfilled });
    // Refused before they left the browser, so the session stayed in the sandbox: recorded as an app finding, not a failure.
    ev.meta('blockedCompanySwitches', blockedSwitches);
    await context.close();
    await approverContext.close();
    await approverApi.dispose();
    await api.dispose();
  }
  tally.assertClean();
  expect(ev.failures(), `evidence: ${ev.file}`).toEqual([]);
});
