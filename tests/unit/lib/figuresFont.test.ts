/**
 * The digit face (master plan 3b): DM Sans has no tabular numerals, so the ten digits come from a
 * self-hosted IBM Plex Sans subset. These pin the wiring a browser cannot report on its own: a missing
 * file or a stack that drops the family silently puts digits back in DM Sans (the Playwright digit-width
 * check catches that on a running app; this catches it at commit).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';

const ROOT = process.cwd();
const css = readFileSync(`${ROOT}/styles/globals.css`, 'utf8');
const tailwind = readFileSync(`${ROOT}/tailwind.config.mjs`, 'utf8');
const documentTsx = readFileSync(`${ROOT}/pages/_document.tsx`, 'utf8');

const faces = [...css.matchAll(/@font-face\s*{[^}]*}/g)]
  .map((m) => m[0])
  .filter((rule) => rule.includes("font-family: 'IsaFlow Figures';"));

describe('the figures face', () => {
  it('declares 400, 500 and 600-700, each digits-only and self-hosted', () => {
    expect(faces).toHaveLength(3);
    for (const rule of faces) {
      expect(rule).toMatch(/unicode-range:\s*U\+0030-0039;/);
      const url = /url\('(\/fonts\/figures\/[^']+\.woff2)'\)/.exec(rule)?.[1];
      expect(url, rule).toBeDefined();
      expect(existsSync(`${ROOT}/public${url}`), `${url} is shipped`).toBe(true);
      expect(statSync(`${ROOT}/public${url}`).size, `${url} is a subset, not the full face`).toBeLessThan(5000);
      expect(rule).not.toMatch(/https?:/);
    }
  });

  it('has a metrics-matched fallback for the digits while a face loads', () => {
    expect(css).toMatch(/font-family: 'IsaFlow Figures Fallback';[^}]*size-adjust:\s*107\.9\d*%;[^}]*unicode-range:\s*U\+0030-0039/);
    // line boxes: Plex's ascent/descent/line-gap (1025/275/0 per 1000 em) over the size-adjust
    expect(css).toMatch(/ascent-override:\s*94\.99%;[^}]*descent-override:\s*25\.48%;[^}]*line-gap-override:\s*0%/);
  });

  it('is first in the sans stack, ahead of DM Sans', () => {
    const stack = /sans: \[([\s\S]*?)\],/.exec(tailwind)?.[1] ?? '';
    const order = ["'IsaFlow Figures'", "'IsaFlow Figures Fallback'", 'var(--font-dm-sans'].map((name) => stack.indexOf(name));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('preloads the 400 face', () => {
    expect(documentTsx).toMatch(/rel="preload" href="\/fonts\/figures\/IBMPlexSans-Digits-Regular\.woff2" as="font"/);
  });
});
