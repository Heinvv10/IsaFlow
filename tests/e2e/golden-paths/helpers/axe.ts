/**
 * Accessibility gate for golden-path specs.
 *
 *   await openScreen(page, A11Y_SCREENS[0]);            // goto, wait for data, assert it IS that screen
 *   await expectNoSeriousA11yViolations(page, { exclude: ['#chart'] });
 *
 * Runs axe-core over the page and fails on any 'serious' or 'critical' violation not in ../a11y-baseline.json,
 * printing rule id, impact and target. Violations that existed when the gate was introduced are baselined there
 * (page + rule + context selector + max node count). The baseline may only shrink: fix a violation and delete its
 * entry - an entry that no longer occurs fails the run too. Never add an entry to make a red run green.
 *
 * A11Y_GATE=report (default: enforce) turns every failure into a test annotation, INCLUDING the ones openScreen
 * raises (wrong path, missing heading, a page that never settles) and an axe run that itself errors: in report mode
 * the a11y checks can never fail a run. scripts/verify-deploy.sh sets it: that run is against production data the
 * dev-recorded baseline knows nothing about, and a red run there rolls the deploy back.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describeTargets } from './a11yDescribe';
import type { A11yScreen } from './a11yScreens';
import {
  evaluateGate, gateMode, pageKeyOf, screenMismatch, seriousViolations, type BaselineFile, type Violation,
} from './a11yBaseline';

export interface A11yOptions {
  /** Limit the scan to these selectors (AxeBuilder.include). */
  include?: string[];
  /** Skip these selectors (AxeBuilder.exclude). */
  exclude?: string[];
  /** Baseline key; defaults to the page's path with ids collapsed. */
  key?: string;
  /** Test seam: the baseline to compare with (default: a11y-baseline.json). */
  baseline?: BaselineFile;
  /** Scan the app shell's own controls too (default: they are excluded, see SHELL_EXCLUDES). */
  includeShell?: boolean;
}

/**
 * Shell controls whose presence depends on data and async state, so they cannot be a stable part of every page's
 * baseline. The Setup-guide button's count badge renders only after /api/accounting/setup-guide and
 * /api/auth/preferences resolve, and disappears once nothing remains to set up. Its violation is covered by one
 * dedicated test (n-a11y-main-screens: "setup guide badge") that waits for the badge.
 */
export const SETUP_GUIDE_BUTTON = 'header button[aria-label^="Setup guide"]';
const SHELL_EXCLUDES = [SETUP_GUIDE_BUTTON];

const BASELINE_FILE = join(__dirname, '..', 'a11y-baseline.json');

function loadBaseline(): BaselineFile {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as BaselineFile;
}

async function collectViolations(page: Page, opts: A11yOptions): Promise<Violation[]> {
  let builder = new AxeBuilder({ page });
  for (const s of opts.include ?? []) builder = builder.include(s);
  for (const s of [...(opts.includeShell ? [] : SHELL_EXCLUDES), ...(opts.exclude ?? [])]) builder = builder.exclude(s);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const targets = serious.flatMap((v) => v.nodes.map((n) => n.target.map(String)));
  const names = new Map(targets.map((t, i) => [t.join('\u0000'), i]));
  const described = await page.evaluate(describeTargets, [...names.keys()].map((k) => k.split('\u0000')));
  return seriousViolations(serious, (target) => described[names.get(target.map(String).join('\u0000')) ?? -1] ?? target.join(' >> '));
}

export async function expectNoSeriousA11yViolations(page: Page, opts: A11yOptions = {}): Promise<void> {
  const mode = gateMode(process.env.A11Y_GATE);
  const key = opts.key ?? pageKeyOf(page.url());
  let found: Violation[];
  try {
    found = await collectViolations(page, opts);
  } catch (err) {
    if (mode === 'enforce') throw err;
    test.info().annotations.push({ type: 'a11y-gate-report', description: `${key}: axe could not run: ${errorText(err)}` });
    return;
  }
  const verdict = evaluateGate(mode, key, found, opts.baseline ?? loadBaseline());
  for (const a of verdict.annotations) test.info().annotations.push(a);
  if (verdict.failure) throw new Error(verdict.failure);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);

/**
 * Wait until a page has rendered its data, so axe scans the real screen and not a skeleton.
 * `networkidle` is not usable here: the app keeps polling and posting page-visit events, so it never settles.
 */
async function waitForScreenReady(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.locator('.animate-pulse, .animate-spin, [aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Go to a screen and prove we are on it: the path (a redirect fails here) and its own heading. In report mode a
 * failure is an annotation and the result is false (the caller's functional steps carry on); in enforce it throws.
 */
export async function openScreen(page: Page, screen: A11yScreen): Promise<boolean> {
  const mode = gateMode(process.env.A11Y_GATE);
  try {
    await page.goto(screen.path);
    await waitForScreenReady(page);
    const mismatch = screenMismatch(page.url(), screen.path);
    expect(mismatch, `a11y screen "${screen.name}"`).toBeNull();
    await expect(page.getByRole('heading', { name: screen.heading, exact: true }), `a11y screen "${screen.name}" heading`).toBeVisible();
    return true;
  } catch (err) {
    if (mode === 'enforce') throw err;
    test.info().annotations.push({ type: 'a11y-gate-report', description: `${screen.name}: could not open ${screen.path}: ${errorText(err)}` });
    return false;
  }
}
