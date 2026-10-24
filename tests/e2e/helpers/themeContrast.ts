/**
 * WCAG AA text-contrast audit that walks computed styles in the live page.
 *
 * Why not axe-core: axe's color-contrast rule is not installed in this tree. This walks every
 * visible text node and compares its computed colour (opacity folded in) with the background
 * composited down the DOM ancestor chain, taking the worst colour stop of a gradient. It does
 * not model overlapping siblings (axe uses the paint stack), so it can differ from axe at the
 * edges; it is the same measurement as the look-and-feel probe that scored the light theme 1.38.
 * AA: 4.5:1 for body text, 3:1 for large text (>= 24 px, or >= 18.66 px bold).
 */
import type { Page } from '@playwright/test';

export interface ContrastFailure {
  text: string;
  ratio: number;
  required: number;
  fg: string;
  bg: string;
  el: string;
}

export interface ContrastReport {
  total: number;
  failing: ContrastFailure[];
  worst: number;
}

/** Runs in the browser: must be self-contained (no imports, no closures). */
function auditInPage(): ContrastReport {
  type RGBA = [number, number, number, number];
  const ctx = document.createElement('canvas').getContext('2d');

  const parse = (css: string): RGBA | null => {
    const m = css.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)$/);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [+m[1], +m[2], +m[3], a];
    }
    if (!ctx || css === 'transparent') return css === 'transparent' ? [0, 0, 0, 0] : null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top: RGBA, base: RGBA): RGBA => {
    const a = top[3] + base[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = (i: number) => (top[i] * top[3] + base[i] * base[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const lum = (c: RGBA): number => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: RGBA, b: RGBA): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const rootScheme = getComputedStyle(document.documentElement).colorScheme;
  const canvas: RGBA = rootScheme.includes('dark') && !rootScheme.includes('light')
    ? [18, 18, 18, 1]
    : [255, 255, 255, 1];

  /** Candidate backgrounds under `el`: one per gradient stop, so the worst case is judged. */
  const backgrounds = (el: Element | null): RGBA[] => {
    if (!el) return [canvas];
    const below = backgrounds(el.parentElement);
    const cs = getComputedStyle(el);
    const layers: RGBA[] = [];
    const bi = cs.backgroundImage;
    if (bi && bi !== 'none' && /gradient/.test(bi)) {
      const stops = bi.match(/rgba?\([^)]*\)/g) ?? [];
      for (const s of stops.slice(0, 4)) {
        const c = parse(s);
        if (c) layers.push(c);
      }
    }
    const bg = parse(cs.backgroundColor);
    if (bg && bg[3] > 0) layers.push(bg);
    if (layers.length === 0) return below;
    const out: RGBA[] = [];
    for (const l of layers) for (const b of below) out.push(over(l, b));
    return out.slice(0, 16);
  };

  const effectiveOpacity = (el: Element | null): number => {
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
    return o;
  };
  const visible = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    }
    return effectiveOpacity(el) > 0.01;
  };
  const label = (el: Element): string => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };

  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'OPTGROUP', 'TITLE', 'HEAD']);
  const seen = new Set<Element>();
  const failing: ContrastFailure[] = [];
  let total = 0;
  let worst = Infinity;

  const check = (el: Element, text: string) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (skipTags.has(el.tagName) || el.closest('[aria-hidden="true"],[inert]')) return;
    if ((el as HTMLButtonElement).disabled || el.closest(':disabled')) return;
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color);
    if (!fg0) return;
    const alpha = fg0[3] * effectiveOpacity(el);
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const required = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    let min = Infinity;
    let minBg: RGBA = canvas;
    let minFg: RGBA = fg0;
    for (const bg of backgrounds(el)) {
      const fg = over([fg0[0], fg0[1], fg0[2], alpha], bg);
      const rt = ratio(fg, bg);
      if (rt < min) { min = rt; minBg = bg; minFg = fg; }
    }
    total += 1;
    worst = Math.min(worst, min);
    if (min < required) {
      const hex = (c: RGBA) => `rgb(${c.slice(0, 3).map((v) => Math.round(v)).join(',')})`;
      failing.push({
        text: text.trim().replace(/\s+/g, ' ').slice(0, 48),
        ratio: Math.round(min * 100) / 100,
        required,
        fg: hex(minFg),
        bg: hex(minBg),
        el: label(el),
      });
    }
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent ?? '';
    if (t.trim() && n.parentElement) check(n.parentElement, t);
  }
  for (const el of Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea'))) {
    const v = (el as HTMLInputElement).value;
    if (v) check(el, v);
  }
  return { total, failing, worst: worst === Infinity ? 21 : Math.round(worst * 100) / 100 };
}

export async function auditContrast(page: Page): Promise<ContrastReport> {
  return page.evaluate(auditInPage);
}
