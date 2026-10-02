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

describe('normaliseOptionText callbacks and cycles', () => {
  it('cleans the string a formatter returns, and keeps this and length', () => {
    const formatter = function (this: { tag: string }, a: unknown, b: unknown) { return `${this.tag}${String(a)}\u0001${String(b)}`; };
    const out = normaliseOptionText({ label: { formatter } }) as { label: { formatter: typeof formatter } };
    expect(out.label.formatter.call({ tag: 'T' }, 'x', 'y')).toBe('Txy');
    expect(out.label.formatter.length).toBe(2);
  });
  it('cleans the text inside the element a renderItem returns', () => {
    const renderItem = () => ({ type: 'text', style: { text: 'fig\u0002' } });
    const out = normaliseOptionText({ series: [{ renderItem }] }) as { series: Array<{ renderItem: () => { style: { text: string } } }> };
    expect(out.series[0]!.renderItem().style.text).toBe('fig');
  });
  it('renders a chart whose formatter returns a control character', () => {
    const svg = renderChartSvg({
      xAxis: { type: 'category', data: ['a'] },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `R${v}\u0001` } },
      series: [{ type: 'bar', data: [3] }],
    }, { widthMm: 60, heightMm: 40 });
    expect(svg).toMatch(/>R\d/);
  });
  it('names the path of a circular option instead of overflowing the stack', () => {
    const o: Record<string, unknown> = { series: [{ name: 'a' }] };
    (o.series as Array<Record<string, unknown>>)[0]!.back = o;
    expect(() => normaliseOptionText(o)).toThrow(/circular at option\.series\[0\]\.back/);
  });
  it('does not call a shared (non-circular) reference a cycle', () => {
    const shared = { name: 'x\u0001' };
    expect(normaliseOptionText({ a: shared, b: shared })).toEqual({ a: { name: 'x' }, b: { name: 'x' } });
  });
});
