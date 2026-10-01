/**
 * TWENTY THOUSAND BRIDGES, RENDERED BY ECHARTS AND READ BACK OFF THE SVG.
 *
 * Three rounds fixed bridge labels one case at a time and each fix opened the
 * next, because each was checked against a model of the plot rather than the
 * plot. This draws seeded random bridges — open, up to six movements, some of
 * them tiny, magnitudes from tens to tens of millions, every chart height the
 * pack uses, a long category name one time in four — through the real
 * renderer, and holds every one of them to four things:
 *   - no figure leaves the clip rectangle ECharts drew;
 *   - no figure sits on the wrong side of its bar's base;
 *   - no two value ticks stand closer than 18px, at 12px type;
 *   - the clip rectangle is the plot the layout chose the axis for;
 *   - a figure over its own bar reads against what is under most of it.
 */
import { describe, expect, it } from 'vitest';
import { waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import { labelsFit, MIN_TICK_PITCH_PX, waterfallLayout } from '@/modules/accounting/services/packs/packWaterfallDomain';
import { PX_PER_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { bars, clipRect, figures, legibleOnBar, outsideClip, overOwnBar, wrongSide } from './support/bridgeSvg';
import { yAxisTicks } from './support/svgTicks';

const BRIDGES = 20_000;
const HEIGHTS_MM = [48, 55, 60, 66.56, 72, 90, 110];
const LONG = 'Other, not separately captured';
const MIN_PITCH_PX = 18;

function bridge(rnd: () => number): WaterfallStep[] {
  const mag = Math.pow(10, 1 + Math.floor(rnd() * 7));
  const open = Math.round((rnd() - 0.5) * 2 * mag * (rnd() < 0.2 ? 0 : 1));
  const steps: WaterfallStep[] = [{ label: 'Opening', start: 0, end: open, value: open, isSubtotal: true, color: 'blue' }];
  let running = open;
  const count = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < count; i += 1) {
    const move = Math.round((rnd() - 0.5) * 2 * mag * (rnd() < 0.4 ? 0.02 : 1));
    const label = rnd() < 0.25 ? LONG : `Movement ${i + 1}`;
    steps.push({ label, start: running, end: running + move, value: move, isSubtotal: false, color: move >= 0 ? 'green' : 'red' });
    running += move;
  }
  steps.push({ label: 'Closing', start: 0, end: running, value: running, isSubtotal: true, color: 'teal' });
  return steps;
}

describe('bridge figures, fuzzed through the renderer', () => {
  it(`holds ${BRIDGES} seeded bridges to the plot, the side and the pitch`, () => {
    let seed = 20_261_001;
    const rnd = (): number => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    const failures = { offPlot: 0, wrongSide: 0, pitch: 0, plotMismatch: 0, unread: 0, illegibleOnBar: 0 };
    const examples: string[] = [];
    const note = (kind: keyof typeof failures, detail: string): void => {
      failures[kind] += 1;
      if (examples.length < 6) examples.push(`${kind}: ${detail}`);
    };

    for (let i = 0; i < BRIDGES; i += 1) {
      const steps = bridge(rnd);
      const heightMm = HEIGHTS_MM[Math.floor(rnd() * HEIGHTS_MM.length)]!;
      const compact = heightMm <= 48;
      const boxPx = Math.round(heightMm * PX_PER_MM);
      const ask = 2 + Math.floor(rnd() * 6);
      const svg = String(renderChartSvg(
        waterfallOption(steps, "R'000", undefined, ask, compact, undefined, boxPx),
        { widthMm: 174, heightMm },
      ));
      const clip = clipRect(svg);
      const layout = waterfallLayout(steps, boxPx, compact, ask);
      const tag = `#${i} ${heightMm}mm ${JSON.stringify(steps.map((s) => [s.start, s.end]))}`;
      if (Math.abs(clip.height - layout.plotPx) > 1e-6) note('plotMismatch', `${tag} clip ${clip.height} layout ${layout.plotPx}`);

      const drawn = bars(svg);
      const printed = figures(svg);
      if (drawn.length !== steps.length || printed.length !== steps.length) {
        note('unread', `${tag} ${drawn.length} bars, ${printed.length} figures`);
        continue;
      }
      steps.forEach((step, k) => {
        const figure = printed[k]!;
        if (outsideClip(figure, clip)) note('offPlot', `${tag} "${figure.text}" at ${figure.y} vs ${clip.top}–${clip.bottom}`);
        if (overOwnBar(figure, drawn[k]!) && !legibleOnBar(figure, drawn[k]!)) {
          note('illegibleOnBar', `${tag} "${figure.text}" in ${figure.fill} on ${drawn[k]!.fill}`);
        }
        if (step.end !== step.start && wrongSide(figure, drawn[k]!, step.end > step.start)) {
          note('wrongSide', `${tag} "${figure.text}" at ${figure.y}, bar ${drawn[k]!.top}–${drawn[k]!.bottom}`);
        }
      });
      const ticks = yAxisTicks(svg);
      if (ticks.length > 1 && clip.height / (ticks.length - 1) < MIN_PITCH_PX - 0.01) {
        note('pitch', `${tag} ${ticks.length} ticks in ${clip.height}px`);
      }
    }
    expect(failures, examples.join('\n')).toEqual({ offPlot: 0, wrongSide: 0, pitch: 0, plotMismatch: 0, unread: 0, illegibleOnBar: 0 });
  }, 300_000);
});

describe('the layout at its edges', () => {
  it('fits a reach that overshoots a trillion-wide domain by float residue', () => {
    // 10px of bar ending 17px — the label's clearance — under the top, plus
    // half a thousandth of a rand: residue at this magnitude, not overflow.
    const plotPx = 100;
    const unitsPerPx = 1e12 / plotPx;
    const end = 1e12 - 17 * unitsPerPx + 5e-4;
    const steps: WaterfallStep[] = [
      { label: 'Opening', start: 0, end: end - 10 * unitsPerPx, value: end - 10 * unitsPerPx, isSubtotal: true, color: 'blue' },
      { label: 'Up', start: end - 10 * unitsPerPx, end, value: 10 * unitsPerPx, isSubtotal: false, color: 'green' },
    ];
    expect(labelsFit(steps, { min: 0, max: 1e12, splitNumber: 5 }, plotPx)).toBe(true);
  });

  it('draws one step on a plot too short for two legible ones', () => {
    const steps: WaterfallStep[] = [
      { label: 'Opening', start: 0, end: 100, value: 100, isSubtotal: true, color: 'blue' },
      { label: 'Down', start: 100, end: -900, value: -1000, isSubtotal: false, color: 'red' },
      { label: 'Closing', start: 0, end: -900, value: -900, isSubtotal: true, color: 'teal' },
    ];
    // Full chrome is 32 + 72: a 134px box leaves a 30px plot.
    const layout = waterfallLayout(steps, 134, false, 6);
    expect(layout.plotPx).toBeLessThan(2 * MIN_TICK_PITCH_PX);
    expect(layout.domain.splitNumber).toBe(1);
  });
});

