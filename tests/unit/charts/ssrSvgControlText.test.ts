/**
 * A label is ledger data. One stray control byte in it must not refuse the
 * chart: the option's strings are normalised before drawing, the grammar stays
 * strict, and the text shows without the byte.
 */
import { describe, expect, it } from 'vitest';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { normaliseOptionText } from '@/lib/charts/normaliseOptionText';

const option = (label: string) => ({
  xAxis: { type: 'category', data: [label] }, yAxis: { type: 'value' },
  series: [{ type: 'bar', name: label, data: [3] }],
});
const draw = (label: string) => renderChartSvg(option(label), { widthMm: 60, heightMm: 40 });

describe('renderChartSvg with control characters in a label', () => {
  it.each([
    ['a C0 control', 'Smith\u0001 Co', 'Smith Co'],
    ['a NUL', 'Smith\u0000 Co', 'Smith Co'],
    ['a C1 control', 'Smith\u0085 Co', 'Smith Co'],
    ['a vertical tab', 'Smith\u000b Co', 'Smith Co'],
    ['U+2028', 'Smith\u2028Co', 'Smith Co'],
    ['U+2029', 'Smith\u2029Co', 'Smith Co'],
    ['a BOM', '\ufeffSmith Co', 'Smith Co'],
    ['a tab', 'Smith\tCo', 'Smith Co'],
  ])('renders a label with %s, showing the text without it', (_what, dirty, shown) => {
    const svg = draw(dirty);
    expect(svg).toContain(`>${shown}<`);
    // eslint-disable-next-line no-control-regex
    expect(svg).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufeff]/);
  });
});

describe('normaliseOptionText', () => {
  it('does not mutate the caller\'s option', () => {
    const original = option('a\u0001b');
    normaliseOptionText(original);
    expect(original.xAxis.data[0]).toBe('a\u0001b');
  });
  it('passes functions and class instances through untouched', () => {
    class Gradient { stops = ['x\u0001']; }
    const fn = () => 'x';
    const g = new Gradient();
    const out = normaliseOptionText({ f: fn, g, d: new Date(0) });
    expect(out.f).toBe(fn);
    expect(out.g).toBe(g);
    expect(out.d).toBeInstanceOf(Date);
  });
  it('keeps a line feed, for a multi-line label', () => {
    expect(normaliseOptionText('a\nb')).toBe('a\nb');
  });
});
