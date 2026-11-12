/**
 * River design tokens (app audit 11 Nov 2026, colour-tokens.md): the brand anchors, the Tailwind scales that carry
 * them, the light surfaces that are tinted rather than white, and the --ff-* names call sites use that must exist.
 * Reads the real files, so a value changed there is judged here.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import config from '../../../../tailwind.config.mjs';

const root = process.cwd();
const css = readFileSync(join(root, 'styles/globals.css'), 'utf8');
const printCss = readFileSync(join(root, 'styles/print.css'), 'utf8');

function block(selector: string): string {
  const open = new RegExp(`(^|\\n)\\s*${selector.replace('.', '\\.')}(,[^{]*)?\\s\\{`).exec(css);
  if (!open) throw new Error(`no ${selector} block`);
  return css.slice(open.index, css.indexOf('\n  }', open.index));
}
function hex(scope: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(block(scope));
  if (!m?.[1]) throw new Error(`${name} not found in ${scope}`);
  return m[1].toLowerCase();
}
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

const RIVER = {
  deep: '#071a24',
  current: '#0f766e',
  teal: '#14b8a6',
  shallows: '#5eead4',
  mist: '#e6f4f1',
  sand: '#f6f1e7',
  ember: '#f59e0b',
} as const;

type Colors = Record<string, Record<string, string> | string>;
const colors = (config as { theme: { extend: { colors: Colors } } }).theme.extend.colors;

describe('River anchors', () => {
  it.each(Object.entries(RIVER))('--river-%s is the brief palette value', (name, value) => {
    expect(hex(':root', `--river-${name}`)).toBe(value);
  });

  it('the Tailwind river scale carries the same seven values', () => {
    const river = colors.river as Record<string, string>;
    expect(Object.fromEntries(Object.entries(river).map(([k, v]) => [k, v.toLowerCase()]))).toEqual(RIVER);
  });

  it('primary is a teal scale (Current at 700) and accent is the Ember family', () => {
    const primary = colors.primary as Record<string, string>;
    const accent = colors.accent as Record<string, string>;
    expect(primary['600']).not.toBe('#2563eb');
    expect(primary['700']?.toLowerCase()).toBe(RIVER.current);
    expect(accent['500']?.toLowerCase()).toBe(RIVER.ember);
  });
});

describe('--ff-* names in use are declared', () => {
  it.each(['--ff-border', '--ff-border-medium', '--ff-border-hover', '--ff-text-muted', '--ff-brand-500', '--ff-accent'])(
    '%s is declared in the light block',
    (name) => {
      expect(block(':root')).toMatch(new RegExp(`\\n\\s*${name}:`));
    },
  );

  it('every var(--ff-*) used under src/ and pages/ is declared in a stylesheet', () => {
    const declared = readFileSync(join(root, 'styles/packPrintPage.css'), 'utf8') + css;
    const files = execFileSync('git', ['ls-files', 'src', 'pages'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(tsx?|jsx?|css)$/.test(f));
    const used = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(join(root, f), 'utf8').matchAll(/var\((--ff-[a-z0-9-]+)/g)) used.add(m[1] as string);
    }
    expect(used.size).toBeGreaterThan(30);
    const missing = [...used].filter((name) => !new RegExp(`${name}:`).test(declared));
    expect(missing).toEqual([]);
  });
});

describe('light mode is tinted, not stark white', () => {
  it.each(['--ff-bg-primary', '--ff-bg-secondary', '--ff-surface-primary', '--ff-canvas-base'])('%s is not #ffffff', (name) => {
    expect(hex(':root', name)).not.toBe('#ffffff');
  });

  it('the page is Mist', () => {
    expect(hex(':root', '--ff-bg-primary')).toBe(RIVER.mist);
    expect(hex(':root', '--ff-canvas-base')).toBe(RIVER.mist);
  });

  it('dark mode is built on Deep', () => {
    expect(hex('.dark', '--ff-bg-primary')).toBe(RIVER.deep);
    expect(hex('.dark', '--ff-canvas-base')).toBe(RIVER.deep);
  });

  it.each([':root', '.dark'])('%s strong border is 3:1 or better on page and card', (scope) => {
    const border = hex(scope, '--ff-border-secondary');
    for (const bg of ['--ff-bg-primary', '--ff-bg-secondary']) {
      expect(contrast(border, hex(scope, bg)), `${border} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the field fill is the lightest light surface, so an enabled field never looks disabled', () => {
    const field = luminance(hex(':root', '--ff-field-bg'));
    for (const name of ['--ff-bg-primary', '--ff-bg-secondary', '--ff-bg-tertiary', '--ff-surface-secondary']) {
      expect(field, name).toBeGreaterThan(luminance(hex(':root', name)));
    }
  });
});

describe('print keeps white paper', () => {
  const paper = /html\.print-mode\s*\{([^}]*)\}/.exec(printCss)?.[1] ?? '';

  it.each([
    ['--ff-bg-primary', '#ffffff'],
    ['--ff-surface-primary', '#ffffff'],
    ['--ff-text-primary', '#111827'],
    ['--ff-text-secondary', '#4b5563'],
    ['--ff-text-tertiary', '#5b6573'],
  ])('%s is %s under html.print-mode', (name, value) => {
    expect(paper).toMatch(new RegExp(`${name}:\\s*${value}\\s*;`));
  });
});
