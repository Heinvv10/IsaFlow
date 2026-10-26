/** Shared by the o-theme-* golden specs. */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export const THEMES = ['light', 'dark'] as const;
export type ThemeName = (typeof THEMES)[number];

/** Wait for the app shell and for spinners/skeletons to clear, so the page is the screen and not its loading state. */
export async function settle(page: Page): Promise<void> {
  await page.waitForSelector('main', { timeout: 60_000 });
  await page.waitForFunction(
    () => !document.querySelector('.animate-spin, .animate-pulse, [aria-busy="true"]'),
    undefined,
    { timeout: 30_000 },
  );
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
