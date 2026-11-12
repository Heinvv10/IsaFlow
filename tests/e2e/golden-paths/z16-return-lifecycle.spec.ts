// golden:dev-only
/**
 * Golden path Z16 (wave 5 L2): the tax return lifecycle on the VAT201 page, in a sandbox company only (never Demo).
 *
 * Finalise a VAT201 -> mark it filed -> amend it with a reason -> finalise and file the next version, all through the
 * lifecycle bar; the versions drawer then lists both versions with the amend reason. Axe reports 0 critical and 0 serious
 * with the bar and with the drawer open, at 1568 and 390, in both themes, and the bar fits 390 without a page scroll.
 * The EMP201 page's bar is checked the same way, read-only (it offers Finalise; nothing is finalised). A stale tab is
 * driven too: the next version is finalised through the API behind the page, and the page's Finalise is refused, reloads
 * and offers Amend instead or Close. The file and amend dialogs, the refusal and the drawer pass axe; focus enters the
 * drawer and returns to the Versions button.
 *
 * Nothing goes to SARS: "Mark filed" records a filing made elsewhere, and the ISV send routes are aborted for the run.
 * The sandbox keeps one VAT period whose chain grows by two versions per run; a live version left by an earlier run is
 * amended first through the API. RETURN_EVIDENCE_DIR=<dir> saves a screenshot per width and theme.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'path';
import { Api, gpRef } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { THEMES, rootTheme, settle } from '../helpers/themeSpec';

const PAGE = '/accounting/sars/vat201';
const SANDBOX = { name: '0GP Golden Return Lifecycle Sandbox', onboardingId: '9b3c6e1a-2f4d-4a8b-9c7e-5d1f0a2b3c16' };
const NOTHING_EXCUSED = { pages: {} };
const evidenceDir = process.env.RETURN_EVIDENCE_DIR;

test.setTimeout(300_000);

interface Version { id: string; versionNo: number; status: string }

/** A finished bi-monthly period of last year on the sandbox's alignment (odd: Feb-Mar, even: Jan-Feb). */
async function period(api: Api, companyId: string): Promise<{ start: string; end: string; startText: string; endText: string }> {
  const c = await api.get<Record<string, unknown>>(`/api/accounting/companies?id=${companyId}`);
  const y = new Date().getFullYear() - 1;
  const even = String(c.vatPeriodAlignment ?? c.vat_period_alignment ?? 'odd') === 'even';
  return even
    ? { start: `${y}-01-01`, end: `${y}-02-28`, startText: `1 Jan ${y}`, endText: `28 Feb ${y}` }
    : { start: `${y}-02-01`, end: `${y}-03-31`, startText: `1 Feb ${y}`, endText: `31 Mar ${y}` };
}

async function generate(page: Page, p: { startText: string; endText: string }): Promise<void> {
  for (const [label, text] of [[/^Period Start/, p.startText], [/^Period End/, p.endText]] as const) {
    const field = page.getByLabel(label);
    await field.fill(text);
    await field.press('Tab');
  }
  await page.getByRole('button', { name: 'Generate' }).click();
}

/** The modal zooms in over 200 ms; axe mid-animation reads blended colours. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
}

const status = (page: Page) => page.getByTestId('return-lifecycle-status');

async function act(page: Page, button: RegExp, fill?: { label: RegExp | string; value: string }, axeKey?: string): Promise<void> {
  await page.getByTestId('return-lifecycle').getByRole('button', { name: button }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  if (fill) await dialog.getByLabel(fill.label).fill(fill.value);
  if (axeKey) await settled(page);
  if (axeKey) await expectNoSeriousA11yViolations(page, { include: ['[role="dialog"]'], key: axeKey, baseline: NOTHING_EXCUSED });
  await dialog.getByRole('button', { name: button }).click();
  // A refusal stays in the dialog in the server's words: fail with it rather than with a bare timeout.
  try {
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  } catch (err) {
    const said = await dialog.getByTestId('return-refusal').textContent({ timeout: 1_000 }).catch(() => null);
    throw new Error(said ? `refused: ${said}` : String(err));
  }
}

test('finalise, file, amend, finalise v2 and file it (sandbox)', async ({ page, context, baseURL }) => {
  await page.route('**/api/accounting/sars/efiling-submit**', (r) => r.abort());
  const api = await Api.login(baseURL!);
  const sandboxId = await findOrCreateSandbox(api, SANDBOX);
  await switchApiCompany(api, sandboxId);
  await switchBrowserCompany(context, sandboxId);
  const p = await period(api, sandboxId);

  const q = `periodStart=${p.start}&periodEnd=${p.end}`;
  const before = (await api.get<{ versions: Version[] }>(`/api/accounting/sars/returns/vat201/versions?${q}`)).versions;
  const leftover = before.find((v) => v.status !== 'superseded');
  if (leftover) await api.post('/api/accounting/sars/returns/vat201/amend', { versionId: leftover.id, reason: 'z16: reset for the next run' });
  const n = before.reduce((m, v) => Math.max(m, v.versionNo), 0) + 1;

  await page.setViewportSize({ width: 1568, height: 1000 });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await generate(page, p);
  await expect(status(page)).toHaveText(n === 1 ? 'Not finalised' : `Amended: finalise v${n}`, { timeout: 60_000 });

  await act(page, new RegExp(`^Finalise( v${n})?$`));
  await expect(status(page)).toHaveText(`Finalised (v${n}), not filed`);
  await act(page, /^Mark filed$/, { label: 'SARS eFiling reference', value: gpRef('Z16A') }, 'z16-file-dialog');
  await expect(status(page)).toHaveText(`Filed (v${n})`);
  await act(page, /^Amend$/, { label: /Reason for the amendment/, value: 'z16: a supplier bill was missed' }, 'z16-amend-dialog');
  await expect(status(page)).toHaveText(`Amended: finalise v${n + 1}`);

  // A stale tab: v(n+1) is finalised elsewhere while this page still offers Finalise. The refusal is shown in the
  // server's words, the bar reloads to the truth, and the dialog offers Amend instead or Close.
  await api.post('/api/accounting/sars/returns/vat201/finalise', { periodStart: p.start, periodEnd: p.end });
  await page.getByTestId('return-lifecycle').getByRole('button', { name: `Finalise v${n + 1}` }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^Finalise$/ }).click();
  await expect(dialog.getByTestId('return-refusal')).toContainText(`already finalised as version ${n + 1}. Amend it before finalising again.`);
  await expect(status(page)).toHaveText(`Finalised (v${n + 1}), not filed`);
  await expect(dialog.getByRole('button', { name: 'Amend instead' })).toBeVisible();
  await settled(page);
  await expectNoSeriousA11yViolations(page, { include: ['[role="dialog"]'], key: 'z16-stale-refusal', baseline: NOTHING_EXCUSED });
  if (evidenceDir) await page.screenshot({ path: join(evidenceDir, 'vat201-stale-refusal-1568.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await act(page, /^Mark filed$/, { label: 'SARS eFiling reference', value: gpRef('Z16B') });
  await expect(status(page)).toHaveText(`Filed (v${n + 1})`);

  const steps = page.getByRole('list', { name: 'Lifecycle steps' });
  await expect(steps).toContainText(`v${n} amended`);
  await expect(steps).toContainText('z16: a supplier bill was missed');
  await expect(steps).toContainText(`v${n + 1} filed`);

  for (const theme of THEMES) {
    for (const width of [1568, 390]) {
      await page.evaluate((t) => window.localStorage.setItem('accounting-theme', t), theme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await generate(page, p);
      await expect(status(page)).toHaveText(`Filed (v${n + 1})`, { timeout: 60_000 });
      expect((await rootTheme(page)).dark, `${theme} theme applied`).toBe(theme === 'dark');
      await settle(page);
      const bar = page.getByTestId('return-lifecycle');
      await bar.scrollIntoViewIfNeeded();
      const box = await bar.boundingBox();
      expect(box!.x + box!.width, `the bar fits ${width}`).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no page scroll sideways').toBeLessThanOrEqual(width);
      await expectNoSeriousA11yViolations(page, { include: ['[data-testid="return-lifecycle"]'], key: 'z16-return-lifecycle', baseline: NOTHING_EXCUSED });
      if (evidenceDir) await bar.screenshot({ path: join(evidenceDir, `vat201-lifecycle-${theme}-${width}.png`) });

      const versionsButton = bar.getByRole('button', { name: /^Versions \(/ });
      await versionsButton.click();
      const drawer = page.getByTestId('return-versions-drawer');
      await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), 'focus moves into the drawer').toBe(true);
      await expect(drawer.getByRole('article', { name: `Version ${n}` })).toContainText('z16: a supplier bill was missed');
      await expect(drawer.getByRole('article', { name: `Version ${n}` })).not.toContainText('Lock removed');
      await expect(drawer.getByRole('article', { name: `Version ${n + 1}` })).toContainText('filed');
      await expectNoSeriousA11yViolations(page, { include: ['[role="dialog"]'], key: 'z16-return-versions', baseline: NOTHING_EXCUSED });
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `vat201-versions-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(versionsButton, 'focus returns to the Versions button').toBeFocused();

      // EMP201, read-only: the default (previous) month, never finalised here; the bar offers Finalise.
      await page.goto('/accounting/sars/emp201', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Generate' }).click();
      const empBar = page.getByTestId('return-lifecycle');
      await expect(empBar.getByTestId('return-lifecycle-status')).not.toHaveText('Loading…', { timeout: 60_000 });
      await expect(empBar.getByRole('button', { name: /^Finalise v\d+$/ })).toBeVisible();
      await settle(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), 'EMP201: no page scroll sideways').toBeLessThanOrEqual(width);
      await expectNoSeriousA11yViolations(page, { include: ['[data-testid="return-lifecycle"]'], key: 'z16-emp201-lifecycle', baseline: NOTHING_EXCUSED });
      if (evidenceDir) await empBar.screenshot({ path: join(evidenceDir, `emp201-lifecycle-${theme}-${width}.png`) });
      await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    }
  }
});
