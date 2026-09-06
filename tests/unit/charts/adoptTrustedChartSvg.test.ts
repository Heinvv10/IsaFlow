/**
 * `adoptTrustedChartSvg` — the only way a chart that crossed a JSON boundary
 * gets its brand back.
 *
 * Two things are being held here, and the second is the one that is easy to
 * lose. The first is obvious: hostile markup must be refused. The second is
 * that the refusal stays POSITIONAL. `assertNoExternalReferences` strips
 * `<text>` bodies before it looks for a fetch surface, because a customer
 * name containing a URL once aborted a whole pack render — and the tempting
 * "belt and braces" addition at a deserialisation boundary is a blacklist
 * scan over the raw string, which reinstates exactly that defect. The
 * accepts-a-URL-in-a-label case below fails the moment somebody adds one.
 */
import { describe, it, expect } from 'vitest';
import {
  adoptTrustedChartSvg,
  renderChartSvg,
  CHART_HEIGHT_MM,
} from '@/lib/charts/ssrSvg';

const SIZE = { widthMm: 170, heightMm: CHART_HEIGHT_MM.half };

/** A real chart, not a hand-written `<svg/>`: the guards are shaped around
 *  what zrender actually emits (a CDATA `<style>` block of `:hover` rules
 *  among other things), so a stub would pass them for the wrong reason. */
const realChart = () =>
  renderChartSvg(
    {
      xAxis: { type: 'category', data: ['Mar', 'Apr'] },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: [10, 20], emphasis: { itemStyle: { color: '#1a3a5c' } } }],
    },
    SIZE,
  );

describe('adoptTrustedChartSvg', () => {
  it('re-brands markup this process actually rendered, unchanged and byte-for-byte', () => {
    const svg = realChart();
    // Through a REAL round trip. The brand is erased by JSON.parse; that is
    // the whole reason this function exists.
    const overTheWire: unknown = JSON.parse(JSON.stringify({ svg }))?.svg;

    expect(adoptTrustedChartSvg(overTheWire)).toBe(svg);
  });

  it.each([
    ['an image element', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/p.png"/></svg>'],
    ['a script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil.example")</script></svg>'],
    ['a foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><b>x</b></foreignObject></svg>'],
    ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="fetch(1)"/></svg>'],
    ['an xlink href', '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="https://evil.example/#a"/></svg>'],
  ])('refuses markup carrying %s', (_what, hostile) => {
    expect(() => adoptTrustedChartSvg(hostile)).toThrow(/external reference/i);
  });

  it.each([
    ['a blanking rule', '<svg><style><![CDATA[* { display:none }]]></style></svg>'],
    ['a font fetch', '<svg><style><![CDATA[@font-face { src: url(https://evil.example/f.woff) }]]></style></svg>'],
    ['an injected second rule', '<svg><style><![CDATA[.zrab12-0:hover { fill:#f00 } * { display:none }]]></style></svg>'],
  ])('refuses a <style> block that is not the shape zrender emits — %s', (_what, hostile) => {
    expect(() => adoptTrustedChartSvg(hostile)).toThrow(/style/i);
  });

  /**
   * THE ANTI-BLACKLIST CASE. A URL in a `<text>` body fetches nothing — it is
   * a customer name, an account name, a project code, and those arrive from
   * Sage and bank imports. A guard that scanned the whole string would refuse
   * this and take the entire board pack down with it.
   */
  it('accepts a chart whose LABEL contains an absolute URL', () => {
    const svg = renderChartSvg(
      {
        xAxis: { type: 'category', data: ['https://acme.example/store', 'Apr'] },
        yAxis: { type: 'value' },
        series: [{ type: 'bar', data: [10, 20] }],
      },
      SIZE,
    );

    expect(svg).toContain('https://acme.example/store');
    expect(adoptTrustedChartSvg(svg)).toBe(svg);
  });

  it.each([
    ['null', null],
    ['undefined — a field missing from the payload entirely', undefined],
    ['a number', 42],
    ['an object', { svg: '<svg/>' }],
    ['an array of markup', ['<svg/>']],
  ])('refuses %s where chart markup was expected', (_what, value) => {
    expect(() => adoptTrustedChartSvg(value)).toThrow(/adoptTrustedChartSvg/);
  });
});
