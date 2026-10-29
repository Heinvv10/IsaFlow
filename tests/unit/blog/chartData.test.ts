import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Chart } from '@/components/landing/blog/mdx/Chart';
import { arcPath, niceTicks, normaliseChart } from '@/lib/blog/chartData';

const base = { type: 'bar', title: 'T', source: 'S' };

describe('<Chart> data validation', () => {
  it('normalises single-series { label, value } rows', () => {
    const c = normaliseChart({ ...base, data: [{ label: 'Jan', value: 3 }, { label: 'Feb', value: 5 }] });
    expect(c.labels).toEqual(['Jan', 'Feb']);
    expect(c.series).toEqual([{ name: 'T', values: [3, 5] }]);
    expect(c.height).toBe(320);
  });

  it('normalises multi-series { label, values } rows', () => {
    const c = normaliseChart({
      ...base,
      type: 'line',
      data: [{ label: 'Q1', values: { In: 4, Out: 2 } }, { label: 'Q2', values: { In: 6, Out: 3 } }],
    });
    expect(c.series).toEqual([{ name: 'In', values: [4, 6] }, { name: 'Out', values: [2, 3] }]);
  });

  it.each([
    ['an unknown type', { ...base, type: 'donut', data: [{ label: 'a', value: 1 }] }, /type/],
    ['a missing source', { type: 'bar', title: 'T', data: [{ label: 'a', value: 1 }] }, /source/],
    ['empty data', { ...base, data: [] }, /data/],
    ['a non-number value', { ...base, data: [{ label: 'a', value: '1' }] }, /data/],
    ['NaN', { ...base, data: [{ label: 'a', value: Number.NaN }] }, /data/],
    ['mixed series keys', { ...base, data: [{ label: 'a', values: { X: 1 } }, { label: 'b', values: { Y: 1 } }] }, /same series keys/],
    ['multi-series pie', { ...base, type: 'pie', data: [{ label: 'a', values: { X: 1 } }] }, /pie charts take single-series/],
    ['negative pie', { ...base, type: 'pie', data: [{ label: 'a', value: -1 }, { label: 'b', value: 2 }] }, /pie values must be >= 0/],
    ['zero pie', { ...base, type: 'pie', data: [{ label: 'a', value: 0 }] }, /sum to more than 0/],
  ])('refuses %s', (_name, props, pattern) => {
    expect(() => normaliseChart(props)).toThrow(pattern);
  });

  it('builds round ticks that include zero', () => {
    expect(niceTicks(3, 22)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(niceTicks(-12, 8)).toEqual([-15, -10, -5, 0, 5, 10]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });

  it('draws a full circle for a single 100% pie slice', () => {
    expect(arcPath(10, 10, 5, 0, Math.PI * 2)).toMatch(/^M 10 5 A 5 5 0 1 1 10 15/);
  });

  it.each(['bar', 'line', 'pie'])('renders a %s chart as SVG with its source caption and a data table', (type) => {
    const html = renderToStaticMarkup(
      createElement(Chart, { type: type as 'bar', title: 'Title', source: 'SARS 2026', data: [{ label: 'A', value: 1 }, { label: 'B', value: 3 }] }),
    );
    expect(html).toContain('<svg');
    expect(html).toContain('role="img"');
    expect(html).toContain('Source: SARS 2026');
    expect(html).toMatch(/<table class="sr-only">/);
  });
});
