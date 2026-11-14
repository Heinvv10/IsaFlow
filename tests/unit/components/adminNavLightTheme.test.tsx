// Admin nav in the light theme (admin audit 4.4): the sidebar is white in light mode, and inactive items were
// text-gray-300 / text-gray-400 with no light variant, pale grey on white. Inactive items now take their colour from
// the theme's ink tokens (--ff-text-secondary / -tertiary, dark on light and light on dark), not from a raw grey.
// Two levels: (1) the rendered nav's CLASS names (happy-dom applies no Tailwind CSS, so no computed colour exists
// here); (2) the tokens behind those classes: tailwind.config maps ink-muted / ink-faint to the CSS variables, and
// styles/globals.css gives them values that reach WCAG AA (4.5:1) on the sidebar in both themes.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/admin/billing', asPath: '/admin/billing', query: {} }) }));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindConfig from '../../../tailwind.config.mjs';
import { AdminNav } from '@/components/admin/AdminNav';

afterEach(cleanup);

const classes = (name: string) => screen.getByRole('link', { name }).className.split(/\s+/);
const rawText = (cls: string[]) => cls.filter((c) => /^(hover:)?text-(gray|slate|white)(-\d+)?$/.test(c));

describe('AdminNav inactive items', () => {
  it.each([
    ['Companies', 'text-ink-muted'], // top level, no children
    ['Tools', 'text-ink-muted'],     // top level with children, closed
    ['Plans', 'text-ink-faint'],     // child of the open Billing section
    ['Invoices', 'text-ink-faint'],
  ])('%s uses %s and no raw grey or white text', (name, token) => {
    render(<AdminNav />);
    const cls = classes(name);
    expect(cls).toContain(token);
    expect(cls).toContain('hover:text-ink');
    expect(rawText(cls)).toEqual([]);
  });

  it('the active item keeps its brand fill', () => {
    render(<AdminNav />);
    expect(classes('Billing')).toContain('bg-brand-600');
  });
});

// WCAG relative luminance contrast of two #rrggbb colours.
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('ink tokens behind the classes', () => {
  const css = readFileSync(path.resolve(__dirname, '../../../styles/globals.css'), 'utf8');
  const darkBlock = css.slice(css.indexOf('.dark {'));
  const value = (block: string, name: string) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1] ?? '';

  it('ink-muted and ink-faint are the --ff-text-secondary / -tertiary variables', () => {
    const ink = (tailwindConfig as { theme: { extend: { colors: { ink: Record<string, string> } } } }).theme.extend.colors.ink;
    expect(ink.muted).toBe('var(--ff-text-secondary)');
    expect(ink.faint).toBe('var(--ff-text-tertiary)');
  });

  it.each(['--ff-text-secondary', '--ff-text-tertiary'])('%s reaches 4.5:1 on the light and the dark sidebar', (name) => {
    const light = value(css, name);
    const dark = value(darkBlock, name);
    // Light sidebar: bg-white, which the signed-in shell maps to #f5faf8 (--rv-white); dark: #071a24 (--rv-gray-900).
    for (const bg of ['#ffffff', '#f5faf8']) expect(contrast(light, bg), `${name} ${light} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark, '#071a24'), `${name} ${dark} on #071a24`).toBeGreaterThanOrEqual(4.5);
  });
});
