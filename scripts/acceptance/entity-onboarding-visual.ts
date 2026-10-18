// Screenshots and layout measurements for the entity-onboarding acceptance. Every measurement is an assertion
// on the scenario's Result (check), so a layout regression fails the scenario instead of only being logged.
import type { Page } from 'playwright';
import { OUT, allShots, check, trace, type Combo, type Result } from './entity-onboarding-support';

export async function shot(page: Page, r: Result, slug: string, combos: Combo[]) {
  for (const [vp, theme] of combos) {
    await page.setViewportSize(vp === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    await page.waitForTimeout(250);
    const file = `${String(r.n).padStart(2, '0')}-${slug}-${vp}-${theme}.png`;
    trace(`#${r.n} shot ${file}`);
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: vp === 'mobile', timeout: 120000 }); // generous: the shared box is often heavily loaded
    r.shots.push(file); allShots.push(file);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
}

/**
 * Landed dashboard: switches the app's OWN theme with its header toggle (ThemeContext state). Toggling only the html
 * class leaves context-driven parts dark, and a stored preference does not survive a dev reload (StrictMode re-runs
 * ThemeContext's save effect before its load effect has applied).
 */
export async function shotLanded(page: Page, r: Result, slug: string, combos: Combo[], name: string) {
  await page.getByRole('heading', { name }).first().waitFor({ state: 'visible', timeout: 45000 });
  const toggle = page.locator('button[title="Switch to light mode"], button[title="Switch to dark mode"]');
  for (const [vp, theme] of combos) {
    await page.setViewportSize(vp === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const isDark = (await toggle.getAttribute('title')) === 'Switch to light mode';
    if (isDark !== (theme === 'dark')) await toggle.dispatchEvent('click');
    await page.waitForTimeout(1200);
    const file = `${String(r.n).padStart(2, '0')}-${slug}-${vp}-${theme}.png`;
    trace(`#${r.n} shot ${file}`);
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: false, timeout: 120000 });
    r.shots.push(file); allShots.push(file);
  }
  if ((await toggle.getAttribute('title')) === 'Switch to dark mode') await toggle.dispatchEvent('click');
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** No loading skeleton left on the landed page. The notification-count badge button pulses by design and is not a skeleton. */
export async function expectNoSkeleton(page: Page, r: Result) {
  const left = () => page.evaluate(() => Array.from(document.querySelectorAll('.animate-pulse'))
    .filter(e => !(e.tagName === 'BUTTON' && /^\d+$/.test((e.textContent ?? '').trim())))
    .map(e => `${e.tagName}.${(e.getAttribute('class') ?? '').slice(0, 80)} text="${(e.textContent ?? '').slice(0, 20)}"`));
  const deadline = Date.now() + 15000;
  let rest = await left();
  while (rest.length > 0 && Date.now() < deadline) { await page.waitForTimeout(500); rest = await left(); }
  check(r, rest.length === 0, `landed page has no loading skeleton${rest.length ? `: ${JSON.stringify(rest)}` : ''}`);
}

export const overflow: string[] = [];
/** No page-level horizontal scroll at 390px. */
export async function checkMobile(page: Page, r: Result, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  overflow.push(`${m.sw <= m.iw ? 'OK  ' : 'FAIL'} ${label}: scrollWidth ${m.sw} / innerWidth ${m.iw}`);
  check(r, m.sw <= m.iw, `no horizontal scroll at 390px, ${label}: scrollWidth ${m.sw} / innerWidth ${m.iw}`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

export const idFit: string[] = [];
/** Every 13-digit ID number is fully visible in its input at 390px. */
export async function checkIdInputsFit(page: Page, r: Result, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement>('input[placeholder="ID number"]'))
    .map(i => ({ v: i.value, sw: i.scrollWidth, cw: i.clientWidth })));
  check(r, rows.length > 0, `${label}: ID inputs found at 390px (${rows.length})`);
  for (const x of rows) {
    const ok = x.sw <= x.cw && x.v.length === 13;
    idFit.push(`${ok ? 'OK  ' : 'FAIL'} ${label}: ID ${x.v.length} digits, input scrollWidth ${x.sw} / clientWidth ${x.cw}`);
    check(r, ok, `${label}: ID input not clipped at 390px (${x.v.length} digits, scrollWidth ${x.sw} / clientWidth ${x.cw})`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

type Rgb = [number, number, number];
const parseRgb = (c: string): Rgb | null => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const luminance = ([r, g, b]: Rgb) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a: Rgb, b: Rgb) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

export const logoChecks: string[] = [];
/** Light mode, entity step: the logo loaded and is black (brightness(0)), and card label and hint text are readable on the card. */
export async function checkLogoAndCards(page: Page, r: Result) {
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.waitForTimeout(250);
  const m = await page.evaluate(() => {
    const img = document.querySelector('img[alt="ISAFlow"]') as HTMLImageElement | null;
    const body = getComputedStyle(document.querySelector('div.min-h-screen') as Element);
    const card = document.querySelector('[role=radio]') as HTMLElement;
    const label = card.querySelector('p') as HTMLElement;
    return { filter: img ? getComputedStyle(img).filter : 'no img', loaded: !!img && img.naturalWidth > 0, bg: body.backgroundColor,
      cardBg: getComputedStyle(card).backgroundColor, cardBorder: getComputedStyle(card).borderColor, labelColor: getComputedStyle(label).color,
      hintColor: getComputedStyle(card.querySelectorAll('p')[1] as HTMLElement).color };
  });
  logoChecks.push(JSON.stringify(m));
  check(r, m.loaded, 'light mode: the ISAFlow logo image loaded');
  check(r, m.filter === 'brightness(0)', `light mode: logo filter is brightness(0) (black), got "${m.filter}"`);
  const cardBg = parseRgb(m.cardBg);
  for (const [what, colour] of [['label', m.labelColor], ['hint', m.hintColor]] as const) {
    const fg = parseRgb(colour);
    const ratio = fg && cardBg ? contrast(fg, cardBg) : 0;
    check(r, colour !== m.cardBg && ratio >= 4.5, `light mode: card ${what} ${colour} on card ${m.cardBg}: contrast ${ratio.toFixed(1)} (needs 4.5)`);
  }
  await page.evaluate(() => document.documentElement.classList.add('dark'));
}
