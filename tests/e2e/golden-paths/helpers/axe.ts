/**
 * Accessibility gate for golden-path specs.
 *
 *   await expectNoSeriousA11yViolations(page, { exclude: ['#chart'] });
 *
 * Runs axe-core over the page and fails on any 'serious' or 'critical' violation, printing rule id, impact and
 * target. Violations that already existed when this gate was introduced are listed in ../a11y-baseline.json
 * (page + rule id + selector) and are tolerated; anything NOT in that file fails. The baseline may only shrink:
 * fix a violation and delete its entry (a listed entry that no longer occurs is reported as an annotation).
 * Never add an entry to make a red run green - fix the markup instead.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  diffAgainstBaseline, formatViolations, pageKeyOf, seriousViolations, type BaselineFile, type Violation,
} from './a11yBaseline';

export interface A11yOptions {
  /** Limit the scan to these selectors (AxeBuilder.include). */
  include?: string[];
  /** Skip these selectors (AxeBuilder.exclude). */
  exclude?: string[];
  /** Baseline key; defaults to the page's path with ids collapsed. Use it to tell apart steps that share a URL. */
  key?: string;
}

const BASELINE_FILE = join(__dirname, '..', 'a11y-baseline.json');

function loadBaseline(): BaselineFile {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as BaselineFile;
}

/** Every serious/critical violation currently on the page, baseline ignored. */
export async function collectSeriousViolations(page: Page, opts: A11yOptions = {}): Promise<Violation[]> {
  let builder = new AxeBuilder({ page });
  for (const s of opts.include ?? []) builder = builder.include(s);
  for (const s of opts.exclude ?? []) builder = builder.exclude(s);
  const results = await builder.analyze();
  return seriousViolations(results.violations);
}

export async function expectNoSeriousA11yViolations(page: Page, opts: A11yOptions = {}): Promise<void> {
  const key = opts.key ?? pageKeyOf(page.url());
  const found = await collectSeriousViolations(page, opts);
  const { added, stale } = diffAgainstBaseline(key, found, loadBaseline());

  for (const s of stale) {
    test.info().annotations.push({ type: 'a11y-baseline-stale', description: `${key}: ${s.rule} ${s.selector} no longer occurs - delete it from a11y-baseline.json` });
  }
  expect(added, formatViolations(key, added)).toEqual([]);
}

/**
 * Wait until a page has rendered its data, so axe scans the real screen and not a skeleton.
 * `networkidle` is not usable here: the app keeps polling and posting page-visit events, so it never settles.
 */
export async function waitForScreenReady(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.locator('.animate-pulse, .animate-spin, [aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
}
