import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MoneyField } from '@/components/ui/MoneyField';
import { DateField } from '@/components/ui/DateField';

const css = readFileSync(join(process.cwd(), 'styles/globals.css'), 'utf8');

/** WCAG 2.x relative luminance / contrast ratio for #rrggbb. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
function token(scope: string, name: string): string {
  const block = css.slice(css.indexOf(`${scope} {`));
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m?.[1]) throw new Error(`token ${name} not found in ${scope}`);
  return m[1];
}

describe('focus ring tokens', () => {
  const light = token(':root', '--ff-focus-ring');
  const dark = token('.dark', '--ff-focus-ring');

  it('is 2-3px wide', () => {
    const w = /--ff-focus-ring-width:\s*(\d)px/.exec(css);
    expect(Number(w?.[1])).toBeGreaterThanOrEqual(2);
    expect(Number(w?.[1])).toBeLessThanOrEqual(3);
  });

  it.each([
    ['page', '#ffffff'],
    ['canvas', '#f8fafc'],
    ['raised canvas', '#f1f5f9'],
  ])('light ring meets 3:1 (WCAG 1.4.11) on the %s surface', (_name, bg) => {
    expect(contrast(light, bg)).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['canvas', '#0f172a'],
    ['mid canvas', '#1a1d23'],
    ['input fill', '#1e293b'],
  ])('dark ring meets 3:1 on the %s surface', (_name, bg) => {
    expect(contrast(dark, bg)).toBeGreaterThanOrEqual(3);
  });

  it('the ring is a teal, light and dark', () => {
    expect(light).toBe('#0d9488');
    expect(dark).toBe('#2dd4bf');
  });
});

describe('inset modifier for fields flush in an overflow-hidden parent', () => {
  it('draws the ring inside the control, in both themes, by the full ring width', () => {
    for (const selector of ['.ff-focus-ring.ff-focus-ring-inset:focus-visible', '.dark .ff-focus-ring.ff-focus-ring-inset:focus-visible']) {
      const at = css.indexOf(selector);
      expect(at, selector).toBeGreaterThan(-1);
    }
    expect(css).toMatch(/outline-offset:\s*calc\(var\(--ff-focus-ring-width\) \* -1\)/);
  });
});

describe('kit controls carry the focus ring class', () => {
  it('Button and Input', () => {
    render(
      <>
        <Button>Save</Button>
        <Input label="Name" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('ff-focus-ring');
    expect(screen.getByLabelText('Name').className).toContain('ff-focus-ring');
  });

  it('MoneyField and DateField', () => {
    render(
      <>
        <MoneyField label="Amount" value={null} onChange={() => undefined} />
        <DateField label="Date" value={null} onChange={() => undefined} />
      </>,
    );
    expect(screen.getByLabelText('Amount').className).toContain('ff-focus-ring');
    expect(screen.getByLabelText('Date').className).toContain('ff-focus-ring');
  });
});
