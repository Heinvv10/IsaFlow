// golden:dev-only
/**
 * Golden path O4 - the River light theme is scoped to the signed-in app shell (app audit 11 Nov 2026, c1).
 *
 *  - Inside AppLayout (data-app-shell): bg-white is the card tint, an enabled text field gets the one field fill
 *    (even over a bg-white utility), a read-only field keeps the sunken fill, and text-teal-600/700 is the 800 weight
 *    with hover going darker (900), never lighter.
 *  - Outside the shell (the client portal): bg-white is white, an input keeps its own fill and teal-700 is stock.
 * Probes are injected into the page; read-only, writes no data.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../helpers/navSpec';
import { seedTheme, settle } from '../helpers/themeSpec';

test.setTimeout(120_000);

/** Probe markup: class names that the app already uses, so Tailwind has compiled them. */
const PROBES = `
  <div id="p-white" class="bg-white">x</div>
  <input id="p-field" class="bg-white" value="x" />
  <input id="p-ro" class="bg-[var(--ff-bg-tertiary)]" readonly value="x" />
  <span id="p-t7" class="text-teal-700">x</span>
  <a id="p-link" href="#" class="text-teal-600 hover:text-teal-700" style="display:inline-block;padding:8px">link</a>`;

async function probe(page: Page): Promise<Record<string, string>> {
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
  }, PROBES);
}

test('light theme: River surfaces and text remaps apply inside the app shell', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedTheme(page, 'light');
  await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
  await settle(page);
  expect(await page.locator('[data-app-shell]').count()).toBeGreaterThan(0);

  const c = await probe(page);
  expect(c.white, 'bg-white is the card tint #f5faf8').toBe('rgb(245, 250, 248)');
  expect(c.field, 'an enabled field is the field fill #fcfefd, over bg-white').toBe('rgb(252, 254, 253)');
  expect(c.readonly, 'a read-only field keeps the sunken fill #ddebe7').toBe('rgb(221, 235, 231)');
  expect(c.teal700, 'text-teal-700 is teal-800').toBe('rgb(17, 94, 89)');
  expect(c.link, 'text-teal-600 is teal-800').toBe('rgb(17, 94, 89)');

  await page.locator('#p-link').hover();
  await expect.poll(() => page.locator('#p-link').evaluate((e) => getComputedStyle(e).color), { message: 'hover goes darker: teal-900' })
    .toBe('rgb(19, 78, 74)');
});

test('light theme: outside the app shell, stock neutrals and stock teal-700 stay', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedTheme(page, 'light');
  await page.goto('/portal', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('html[data-theme-applied]');
  expect(await page.locator('[data-app-shell]').count()).toBe(0);

  const c = await probe(page);
  expect(c.white, 'bg-white is white').toBe('rgb(255, 255, 255)');
  expect(c.field, 'an input keeps its own bg-white, no field fill').toBe('rgb(255, 255, 255)');
  expect(c.teal700, 'text-teal-700 is stock').toBe('rgb(15, 118, 110)');
});
