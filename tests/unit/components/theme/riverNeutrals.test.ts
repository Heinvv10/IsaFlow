/**
 * River neutrals (Layer B). Inside the signed-in shell (AppLayout's data-app-shell) the stock neutral stops the shell
 * and the UI kit were written with (bg-white, gray and slate 50 to 300 and 600 to 950) resolve to River surfaces.
 * Everywhere else, and in a print render, they must stay the stock Tailwind values, or marketing, sign-in and the
 * board pack would change too.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import tw from 'tailwindcss/colors';
import config from '../../../../tailwind.config.mjs';

const root = process.cwd();
const css = readFileSync(join(root, 'styles/globals.css'), 'utf8');
const STOPS = ['50', '100', '200', '300', '600', '700', '800', '900', '950'] as const;
const HUES = ['gray', 'slate'] as const;
const SHELL = ':root:has([data-app-shell]):not(.print-mode)';
const SHELL_DARK = ':root.dark:has([data-app-shell]):not(.print-mode)';

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): Map<string, string> {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const body = re.exec(css)?.[2];
  if (body === undefined) throw new Error(`no rule ${selector}`);
  return new Map([...body.matchAll(/(--rv-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()]));
}
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
const toHex = (ch: string) => `#${ch.split(/\s+/).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;

function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('outside the app shell nothing changes', () => {
  const defaults = rule(':root');

  it('--rv-white is pure white', () => {
    expect(defaults.get('--rv-white')).toBe('255 255 255');
  });

  it.each(HUES.flatMap((h) => STOPS.map((s) => [h, s] as const)))('--rv-%s-%s is the stock Tailwind value', (hue, stop) => {
    expect(defaults.get(`--rv-${hue}-${stop}`)).toBe(channels(tw[hue][stop]));
  });
});

describe('inside the app shell', () => {
  const light = rule(SHELL);
  const dark = rule(SHELL_DARK);

  it('the light scope re-points white and every mapped stop', () => {
    expect(light.get('--rv-white')).not.toBe('255 255 255');
    for (const h of HUES) for (const s of STOPS) expect(light.has(`--rv-${h}-${s}`), `${h}-${s}`).toBe(true);
  });

  it('dark resets white and 50 to 300 to stock (they are text stops there)', () => {
    expect(dark.get('--rv-white')).toBe('255 255 255');
    for (const h of HUES) {
      for (const s of ['50', '100', '200', '300'] as const) expect(dark.get(`--rv-${h}-${s}`)).toBe(channels(tw[h][s]));
    }
  });

  const surfaces = ['#e6f4f1', '#f5faf8', '#fcfefd', '#ddebe7'];
  it.each(HUES.flatMap((h) => (['600', '700', '800', '900'] as const).map((s) => [h, s] as const)))(
    'light %s-%s as text is AA on every light surface',
    (hue, stop) => {
      const fg = toHex(light.get(`--rv-${hue}-${stop}`) as string);
      for (const bg of surfaces) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(HUES.flatMap((h) => (['700', '800', '900'] as const).map((s) => [h, s] as const)))(
    'stock gray-400 and slate-400 text is AA on dark %s-%s',
    (hue, stop) => {
      const bg = toHex(light.get(`--rv-${hue}-${stop}`) as string);
      for (const fg of [tw.gray[400], tw.slate[400]]) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe('Tailwind maps the stops to the variables', () => {
  const extend = (config as unknown as { theme: { extend: { colors: Record<string, Record<string, string>>; backgroundColor: Record<string, string> } } }).theme.extend;

  it.each(HUES)('%s has exactly the nine variable stops (400 and 500 stay stock)', (hue) => {
    expect(Object.keys(extend.colors[hue] ?? {}).sort()).toEqual([...STOPS].sort());
    for (const s of STOPS) expect(extend.colors[hue]?.[s]).toBe(`rgb(var(--rv-${hue}-${s}) / <alpha-value>)`);
  });

  it('only bg-white is re-pointed (text-white and border-white stay white)', () => {
    expect(extend.backgroundColor.white).toBe('rgb(var(--rv-white) / <alpha-value>)');
    expect(extend.colors).not.toHaveProperty('white');
  });
});

describe('AppLayout marks the shell', () => {
  it('the root div carries data-app-shell', () => {
    const src = readFileSync(join(root, 'src/components/layout/AppLayout.tsx'), 'utf8');
    expect(src).toMatch(/<div data-app-shell className="flex flex-col h-screen overflow-hidden"/);
  });
});
