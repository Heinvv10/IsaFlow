/**
 * THE DEFAULT-FACE GUARD READS EVERY SPELLING OF zrender's `font` SHORTHAND.
 *
 * A raw zrender text drawn by a `custom` series takes `style.font`, which
 * zrender emits as the `font` shorthand in a `style` attribute. The guard's
 * pattern required the SIZE first, so `bold 12px sans-serif` — weight before
 * size, which is how a bold bar value is written — slipped past it and set
 * the pack's figures in whatever Chromium resolves a bare `sans-serif` to.
 */
import { describe, expect, it } from 'vitest';
import { renderChartSvg } from '@/lib/charts/ssrSvg';

function customText(font: string): unknown {
  return {
    xAxis: { show: false }, yAxis: { show: false },
    series: [{
      type: 'custom',
      data: [[0, 0]],
      renderItem: () => ({ type: 'text', x: 10, y: 20, style: { text: 'fig', font } }),
    }],
  };
}

const render = (font: string) => renderChartSvg(customText(font), { widthMm: 40, heightMm: 20 });

describe('renderChartSvg default-face guard', () => {
  it.each([
    ['plain size first', '12px sans-serif'],
    ['weight prefix', 'bold 12px sans-serif'],
    ['style and weight prefix', 'italic bold 12px sans-serif'],
    ['numeric weight prefix', '600 12px serif'],
    ['line-height suffix', 'bold 12px/1.4 monospace'],
  ])('refuses %s', (_name, font) => {
    expect(() => render(font)).toThrow(/default face/);
  });

  it('accepts a named family in the same shapes', () => {
    expect(() => render('12px "IBM Plex Sans", sans-serif')).not.toThrow();
    expect(() => render('bold 12px "IBM Plex Sans", sans-serif')).not.toThrow();
    expect(() => render('italic bold 12px "IBM Plex Sans"')).not.toThrow();
  });
});
