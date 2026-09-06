/**
 * The render guard's controls, positive and negative, checked directly.
 *
 * Several constructs the guard refuses — `<use>`, an event-handler attribute —
 * are ones no ECharts option can make zrender emit, so a battery that could
 * only go through `renderChartSvg` would cover just the half that is
 * reachable. The guard is exported for that reason and exercised on markup
 * here; the reachable half is covered by ssrSvg.test.ts and
 * ssrSvgStyleGuard.test.ts.
 *
 * The negative controls are label DATA. Each one aborted a whole pack render
 * at some point in this branch's history, or would have under a slightly
 * different guard, and each is the kind of string a customer or supplier name
 * actually carries.
 */
import { describe, expect, it } from 'vitest';
import { assertNoExternalReferences, renderChartSvg, CHART_HEIGHT_MM } from '@/lib/charts/ssrSvg';
import { buildWaterfallOption } from '@/components/accounting/charts/waterfallOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

describe('the guard fires on every fetch surface', () => {
  const HOSTILE: Array<[string, string]> = [
    ['an image element', '<image href="https://evil.example/beacon.png"/>'],
    ['a use element', '<use xlink:href="https://evil.example/y#a"/>'],
    ['a script element', '<script>fetch("https://evil.example")</script>'],
    ['a foreignObject', '<foreignObject><div>x</div></foreignObject>'],
    ['an event handler', '<g onload="alert(1)"></g>'],
    ['uppercase tag and attribute', '<IMAGE HREF="https://evil.example/b.png"/>'],
    ['a construct inside an HTML comment', '<!-- <image href="https://evil.example/b.png"/> -->'],
    ['a spaced xlink:href', '<use xlink:href = "https://evil.example/y#a"/>'],
    // The hazard fix 11 closes: a `>` inside an attribute value used to open
    // what the strip read as a text node, deleting every sibling attribute up
    // to the next `<` — including the href that should have tripped the guard.
    ['an href hidden behind a > in a sibling attribute',
      '<use data-x="a>" xlink:href="https://evil.example/y#a"/><g></g>'],
    ['a handler hidden behind a > in a sibling attribute',
      '<g data-x="a>" onload="alert(1)"></g><g></g>'],
  ];

  for (const [what, body] of HOSTILE) {
    it(`refuses ${what}`, () => {
      expect(() => assertNoExternalReferences(svg(body))).toThrow(/external reference/i);
    });
  }

  it('does not fire on a clean chart', () => {
    expect(() => assertNoExternalReferences(svg('<g><path d="M0 0L1 1"/><text>Sales</text></g>')))
      .not.toThrow();
  });
});

describe('the guard does not fire on label data', () => {
  const STEPS: WaterfallStep[] = [
    { label: 'Revenue', start: 0, end: 1_000_000, value: 1_000_000, isSubtotal: false, color: 'green' },
    { label: 'Net loss', start: 0, end: -600_000, value: -600_000, isSubtotal: true, color: 'blue' },
  ];
  const LABELS = [
    'https://acme.example/inv',
    'see href=below',
    'on load = ready',
    'ONCLICK=X',
    '<script>alert(1)</script>',
    'A"B',
    'A>B',
    'Smith & Co (Pty) Ltd',
  ];

  for (const label of LABELS) {
    it(`renders a label of ${JSON.stringify(label)}`, () => {
      const option = buildWaterfallOption(
        STEPS.map((step, i) => (i === 0 ? { ...step, label } : step)),
        DEFAULT_PALETTE,
      );
      expect(() => renderChartSvg(option, { widthMm: 170, heightMm: CHART_HEIGHT_MM.half }))
        .not.toThrow();
    });
  }

  it('renders when an attribute value itself contains a > ', () => {
    // `textStyle.fontFamily: 'a>b'` emits `style="…font-family:a>b;"`. Under a
    // blanket `>…<` strip that deleted `transform`, `fill` and the label from
    // the guard's copy of the markup; under a `<text>`-body strip it does not.
    const option = {
      textStyle: { fontFamily: 'a>b' },
      xAxis: { type: 'category', data: ['Sales', 'Rent'] },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: [1, 2] }],
    };
    expect(() => renderChartSvg(option, { widthMm: 170, heightMm: CHART_HEIGHT_MM.half }))
      .not.toThrow();
  });
});
