/** Shared by the o-theme-* golden specs. */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export const THEMES = ['light', 'dark'] as const;
export type ThemeName = (typeof THEMES)[number];

/**
 * Upper bound for a page to stop showing spinners/skeletons. Not an expected time: a passing run returns the moment
 * the page is quiet. Measured on dev with every /api call delayed 3 s, the dashboard clears at ~35 s and
 * /accounting/ar/receipt-match at ~16 s, and a page that fires one request per row costs ceil(rows / 6) x delay
 * (the browser allows 6 connections per host), so 30 s was under what a loaded runner needs. Nothing spins forever.
 */
export const SETTLE_MS = 90_000;

/** Wait for the app shell and for spinners/skeletons to clear, so the page is the screen and not its loading state. */
export async function settle(page: Page): Promise<void> {
  await page.waitForSelector('main', { timeout: SETTLE_MS });
  try {
    await page.waitForFunction(
      () => !document.querySelector('.animate-spin, .animate-pulse, [aria-busy="true"]'),
      undefined,
      { timeout: SETTLE_MS },
    );
  } catch (err) {
    // Say what is still busy, so a real hang is told apart from a slow page.
    const busy = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.animate-spin, .animate-pulse, [aria-busy="true"]'))
        .slice(0, 5).map((e) => e.className.toString().slice(0, 60)));
    throw new Error(`page still busy after ${SETTLE_MS} ms: ${JSON.stringify(busy)}`, { cause: err });
  }
  await page.evaluate(() => document.fonts.ready);
}

/** axe's color-contrast rule alone: one line per failing node. Complements themeContrast.ts, which sees what axe skips and vice versa. */
export async function axeContrastFailures(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  return results.violations.flatMap((v) =>
    v.nodes.map((n) => `${n.target.join(' ')} - ${n.any[0]?.message ?? v.help}`),
  );
}

/** Start every page load in `theme` (the saved preference is what the app reads). */
export async function seedTheme(page: Page, theme: ThemeName | 'system'): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('accounting-theme', t), theme);
}

export async function rootTheme(page: Page): Promise<{ dark: boolean; scheme: string }> {
  return page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    scheme: getComputedStyle(document.documentElement).colorScheme,
  }));
}

/** Probe markup for the River shell scope: class names the app already uses, so Tailwind has compiled them. */
const SHELL_PROBES = `
  <div id="p-white" class="bg-white">x</div>
  <input id="p-field" class="bg-white" value="x" />
  <input id="p-ro" class="bg-[var(--ff-bg-tertiary)]" readonly value="x" />
  <span id="p-t7" class="text-teal-700">x</span>
  <a id="p-link" href="#" class="text-teal-600 hover:text-teal-700" style="display:inline-block;padding:8px">link</a>`;

/** Inject the shell-scope probes and read their computed colours. The link stays in the page for a hover check (#p-link). */
export async function shellScopeProbe(page: Page): Promise<Record<'white' | 'field' | 'readonly' | 'teal700' | 'link', string>> {
  return page.evaluate((html) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const cs = (id: string) => getComputedStyle(document.getElementById(id)!);
    return {
      white: cs('p-white').backgroundColor,
      field: cs('p-field').backgroundColor,
      readonly: cs('p-ro').backgroundColor,
      teal700: cs('p-t7').color,
      link: cs('p-link').color,
    };
  }, SHELL_PROBES);
}
