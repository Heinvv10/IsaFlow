// golden:dev-only
/**
 * Golden path Z27 (wave 6 EFa): the filing files on the VAT201 and EMP201 lifecycle bars, in a sandbox company only
 * (never Demo).
 *
 * VAT201: a version finalised through the API offers no Mark filed until its filing file is downloaded; the CSV's
 * sha256 is the one the bar then shows, and the JSON names it; a reference that is not a payment reference number is
 * refused in the dialog in the server's words; a PRN files it. EMP201 (a nil return for last month): the CSV and the
 * PDF download, and the CSV's sha256 is the stamp. Axe reports 0 critical and 0 serious on the bar at 1568 and 390 in
 * both themes, with no page scroll at 390. Nothing goes to SARS (the ISV send routes are aborted for the run).
 * FILING_FILES_EVIDENCE_DIR=<dir> saves a screenshot per form, width and theme.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import { join } from 'path';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, settle } from '../helpers/themeSpec';

const SANDBOX = { name: '0GP Golden Filing Files Sandbox', onboardingId: '5d872580-bf8d-4f1c-9c49-30de070cb0fb' };
const NOTHING_EXCUSED = { pages: {} };
const evidenceDir = process.env.FILING_FILES_EVIDENCE_DIR;
test.setTimeout(300_000);

interface Version { id: string; versionNo: number; status: string }
const bar = (page: Page) => page.getByTestId('return-lifecycle');
const status = (page: Page) => page.getByTestId('return-lifecycle-status');
const bytes = async (d: Download) => readFileSync((await d.path())!);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Amends a live version an earlier run left, then finalises a new one through the API. */
async function freshVersion(api: Api, form: 'vat201' | 'emp201', start: string, end: string): Promise<Version> {
  const q = `periodStart=${start}&periodEnd=${end}`;
  const live = (await api.get<{ versions: Version[] }>(`/api/accounting/sars/returns/${form}/versions?${q}`)).versions
    .find((v) => v.status !== 'superseded');
  if (live) await api.post(`/api/accounting/sars/returns/${form}/amend`, { versionId: live.id, reason: 'z27: reset for the next run' });
  return (await api.post<{ version: Version }>(`/api/accounting/sars/returns/${form}/finalise`, { periodStart: start, periodEnd: end })).version;
}

async function download(page: Page, label: string): Promise<Download> {
  const [d] = await Promise.all([page.waitForEvent('download'), bar(page).getByRole('button', { name: label }).click()]);
  return d;
}

async function checkBar(page: Page, form: string, theme: string, width: number): Promise<void> {
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${form}: no page scroll sideways`).toBeLessThanOrEqual(width);
  await expectNoSeriousA11yViolations(page, { include: ['[data-testid="return-lifecycle"]'], key: `z27-${form}-filing-file`, baseline: NOTHING_EXCUSED });
  if (evidenceDir) await bar(page).screenshot({ path: join(evidenceDir, `${form}-filing-file-${theme}-${width}.png`) });
}

test('filing files: download before filing, the stamp is the CSV\'s sha256, a PRN files it (sandbox)', async ({ page, context, baseURL }) => {
  await page.route('**/api/accounting/sars/efiling-submit**', (r) => r.abort());
  const api = await Api.login(baseURL!);
  const sandboxId = await findOrCreateSandbox(api, SANDBOX);
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);

  // VAT201: last year's bi-monthly period on the sandbox's alignment.
  const c = await api.get<Record<string, unknown>>(`/api/accounting/companies?id=${sandboxId}`);
  const y = new Date().getFullYear() - 1;
  const even = String(c.vatPeriodAlignment ?? c.vat_period_alignment ?? 'odd') === 'even';
  const p = even ? { start: `${y}-01-01`, end: `${y}-02-28`, from: `1 Jan ${y}`, to: `28 Feb ${y}` }
    : { start: `${y}-02-01`, end: `${y}-03-31`, from: `1 Feb ${y}`, to: `31 Mar ${y}` };
  const v = await freshVersion(api, 'vat201', p.start, p.end);
  const generateVat = async () => {
    for (const [label, text] of [[/^Period Start/, p.from], [/^Period End/, p.to]] as const) {
      await page.getByLabel(label).fill(text);
      await page.getByLabel(label).press('Tab');
    }
    await page.getByRole('button', { name: 'Generate' }).click();
  };
  await page.setViewportSize({ width: 1568, height: 1000 });
  await page.goto('/accounting/sars/vat201', { waitUntil: 'domcontentloaded' });
  await generateVat();
  await expect(status(page)).toHaveText(`Finalised (v${v.versionNo}), not filed`, { timeout: 60_000 });
  await expect(bar(page).getByTestId('filing-file-status')).toContainText('Download the filing file');
  await expect(bar(page).getByRole('button', { name: 'Mark filed' })).toHaveCount(0);

  const csv = await download(page, 'Filing file (CSV)');
  expect(csv.suggestedFilename()).toBe(`VAT201_${p.end.slice(0, 7).replace('-', '')}_v${v.versionNo}.csv`);
  const stamp = sha(await bytes(csv));
  await expect(bar(page).getByTestId('filing-file-status')).toContainText(`sha256 ${stamp}`, { timeout: 30_000 });
  const json = JSON.parse((await bytes(await download(page, 'Filing file (JSON)'))).toString('utf8')) as { captureSheetSha256: string };
  expect(json.captureSheetSha256).toBe(stamp);

  // Mark filed: a reference that is not a PRN is refused in the dialog; a PRN files it.
  await bar(page).getByRole('button', { name: 'Mark filed' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('SARS eFiling reference').fill('REF-1');
  await dialog.getByRole('button', { name: 'Mark filed' }).click();
  await expect(dialog.getByTestId('return-refusal')).toContainText('payment reference number (PRN)');
  await dialog.getByLabel('SARS eFiling reference').fill(`4123456789V${String(Date.now() % 1e8).padStart(8, '0')}`);
  await dialog.getByRole('button', { name: 'Mark filed' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(status(page)).toHaveText(`Filed (v${v.versionNo})`);

  // EMP201: a nil return for last month, finalised through the API.
  const now = new Date();
  const m0 = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));
  const m1 = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 0));
  const e = await freshVersion(api, 'emp201', m0.toISOString().slice(0, 10), m1.toISOString().slice(0, 10));
  await page.goto('/accounting/sars/emp201', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(status(page)).toHaveText(`Finalised (v${e.versionNo}), not filed`, { timeout: 60_000 });
  const pdf = await download(page, 'Filing file (PDF)');
  expect((await bytes(pdf)).subarray(0, 5).toString()).toBe('%PDF-');
  const empCsv = await bytes(await download(page, 'Filing file (CSV)'));
  expect(empCsv.toString('utf8')).toContain('"Payment details","Tax payable",0.00');
  await expect(bar(page).getByTestId('filing-file-status')).toContainText(`sha256 ${sha(empCsv)}`);

  for (const theme of THEMES) {
    for (const width of [1568, 390]) {
      await page.evaluate((t) => window.localStorage.setItem('accounting-theme', t), theme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto('/accounting/sars/emp201', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Generate' }).click();
      await expect(bar(page).getByTestId('filing-file-status')).toContainText('sha256', { timeout: 60_000 });
      await checkBar(page, 'emp201', theme, width);
      await page.goto('/accounting/sars/vat201', { waitUntil: 'domcontentloaded' });
      await generateVat();
      await expect(status(page)).toHaveText(`Filed (v${v.versionNo})`, { timeout: 60_000 });
      await checkBar(page, 'vat201', theme, width);
    }
  }
});
