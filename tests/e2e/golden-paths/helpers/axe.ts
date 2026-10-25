/**
 * Accessibility gate for the n-a11y-main-screens golden spec.
 *
 *   await openScreen(page, screen);                       // goto, wait for its data, assert it IS that screen
 *   await expectScreenClean(page, screen);                // page scan (+ the screen's data table, scanned apart)
 *   await expectNoSeriousA11yViolations(page, { exclude: ['#chart'] });
 *
 * Runs axe-core over the page and fails on any 'serious' or 'critical' violation not in ../a11y-baseline.json,
 * printing rule id, impact and target. Violations that existed when the gate was introduced are baselined there
 * (page + rule + context selector + max node count). The baseline may only shrink: fix a violation and delete its
 * entry - an entry that no longer occurs fails the run too. Never add an entry to make a red run green.
 *
 * This is a dev/CI gate and nothing else: it is keyed to dev data, so scripts/verify-deploy.sh (a post-deploy run
 * against production whose failure rolls the code back) excludes the whole spec.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripVTControlCharacters } from 'util';
import { describeTargets } from './a11yDescribe';
import type { A11yScreen } from './a11yScreens';
import { evaluateGate, pageKeyOf, screenMismatch, seriousViolations, type BaselineFile, type Violation } from './a11yBaseline';

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
 * dedicated test (n-a11y-main-screens: "setup guide badge") that waits for the button.
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
  const key = opts.key ?? pageKeyOf(page.url());
  const verdict = evaluateGate(key, await collectViolations(page, opts), opts.baseline ?? loadBaseline());
  for (const a of verdict.annotations) test.info().annotations.push(a);
  if (verdict.failure) throw new Error(verdict.failure);
}

/**
 * The scan of one opened screen. A screen with a `rowsTable` is scanned twice: the page without the table, then the
 * table alone under `<page>#rows`, so that row-driven counts never decide the page's own entries.
 */
export async function expectScreenClean(page: Page, screen: A11yScreen, baseline?: BaselineFile): Promise<void> {
  if (!screen.rowsTable) return expectNoSeriousA11yViolations(page, { baseline });
  await expectNoSeriousA11yViolations(page, { exclude: [screen.rowsTable], baseline });
  await expectNoSeriousA11yViolations(page, { include: [screen.rowsTable], key: `${pageKeyOf(page.url())}#rows`, baseline });
}

/**
 * Wait until a page has rendered its data, so axe scans the real screen and not a skeleton.
 * `networkidle` is not usable here: the app keeps polling and posting page-visit events, so it never settles.
 */
async function waitForScreenReady(page: Page, screen: A11yScreen): Promise<void> {
  await inScreen(screen, 'the page still shows a spinner or skeleton after 30s', () =>
    expect(page.locator('.animate-pulse, .animate-spin, [aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 }));
}

/**
 * What went wrong, as text, and TOTAL: nothing in here can throw, whatever was thrown (a revoked Proxy, a `message`
 * getter that throws, a null-prototype object). Objects only - a function is excluded from the message-first path
 * and is printed as a function. Order:
 *   1. an object whose `message` is a string: that message. `message` is read once HERE; an Error from another realm
 *      (not `instanceof Error`, would serialise to "{}") keeps its text this way.
 *   2. any other object: JSON, skipped when it is undefined or throws (circular, throwing toJSON). JSON.stringify
 *      reads the object again, so a NON-string `message` getter is read a second time on this path.
 *   3. String(), then Object.prototype.toString when String() throws.
 * A `message` getter (or any access) that throws is not retried by those fallbacks: the outer catch returns only
 * the sentinel '[unprintable thrown value]'. The caller (inScreen) hands the thrown value over untouched - no
 * `instanceof`, which itself throws on a revoked Proxy - and keeps it as `cause`.
 */
function failureText(err: unknown): string {
  try {
    if (err !== null && typeof err === 'object') {
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      const json = jsonOrNull(err);
      if (json !== null) return json;
    }
    try {
      return String(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  } catch {
    return '[unprintable thrown value]';
  }
}

function jsonOrNull(value: object): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null; // circular, or a throwing toJSON
  }
}

/**
 * Runs a wait; when it fails the error names the screen and what was being waited for, keeps the whole underlying
 * message (Playwright's Expected/Received lines are what say why), and carries the original as `cause`.
 */
async function inScreen<T>(screen: A11yScreen, waitingFor: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const why = stripVTControlCharacters(failureText(err)).trim();
    throw new Error(`a11y screen "${screen.name}" (${screen.path}): ${waitingFor}${why ? `\n${why}` : ''}`, { cause: err });
  }
}

/**
 * Go to a screen and prove we are on it, with its data: the screen's own responses arrived (registered BEFORE the
 * navigation, so none is missed), the path is right (a redirect fails here) and so is its heading, and the screen's
 * own settled-state wait - or the generic spinner wait - has passed.
 */
export async function openScreen(page: Page, screen: A11yScreen): Promise<void> {
  const loaded = Promise.all((screen.responses ?? []).map((re) =>
    page.waitForResponse((r) => re.test(r.url()), { timeout: 30_000 }).catch((err: unknown) => {
      throw new Error(`a11y screen "${screen.name}": no response matching ${re} within 30s (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
    })));
  loaded.catch(() => undefined); // surfaced below, once the navigation has happened
  await page.goto(screen.path);
  await loaded;
  await page.waitForLoadState('load');
  await inScreen(screen, 'no <h1> showed within 30s', () => page.locator('h1').first().waitFor({ state: 'visible', timeout: 30_000 }));
  if (screen.settled) await inScreen(screen, 'the screen never settled', () => screen.settled!(page));
  else await waitForScreenReady(page, screen);
  const mismatch = screenMismatch(page.url(), screen.path);
  expect(mismatch, `a11y screen "${screen.name}"`).toBeNull();
  await expect(page.getByRole('heading', { name: screen.heading, exact: true }), `a11y screen "${screen.name}" heading`).toBeVisible();
}
