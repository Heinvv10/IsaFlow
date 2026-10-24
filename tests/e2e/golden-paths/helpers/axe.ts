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
 * A11Y_GATE=report (default: enforce) turns every failure into a test annotation. scripts/verify-deploy.sh sets
 * it: that run is against production data the dev-recorded baseline knows nothing about.
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
}

const BASELINE_FILE = join(__dirname, '..', 'a11y-baseline.json');

function loadBaseline(): BaselineFile {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as BaselineFile;
}

async function collectViolations(page: Page, opts: A11yOptions): Promise<Violation[]> {
  let builder = new AxeBuilder({ page });
  for (const s of opts.include ?? []) builder = builder.include(s);
  for (const s of opts.exclude ?? []) builder = builder.exclude(s);
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
  const verdict = evaluateGate(mode, key, await collectViolations(page, opts), opts.baseline ?? loadBaseline());
  for (const a of verdict.annotations) test.info().annotations.push(a);
  if (verdict.failure) throw new Error(verdict.failure);
}

/**
 * Wait until a page has rendered its data, so axe scans the real screen and not a skeleton.
 * `networkidle` is not usable here: the app keeps polling and posting page-visit events, so it never settles.
 */
async function waitForScreenReady(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.locator('.animate-pulse, .animate-spin, [aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
}

/** Go to a screen and prove we are on it: the path (a redirect fails here) and its own heading. */
export async function openScreen(page: Page, screen: A11yScreen): Promise<void> {
  await page.goto(screen.path);
  await waitForScreenReady(page);
  const mismatch = screenMismatch(page.url(), screen.path);
  expect(mismatch, `a11y screen "${screen.name}"`).toBeNull();
  await expect(page.getByRole('heading', { name: screen.heading, exact: true }), `a11y screen "${screen.name}" heading`).toBeVisible();
}
