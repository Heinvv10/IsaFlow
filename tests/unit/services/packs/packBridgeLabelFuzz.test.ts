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
 *   - the clip rectangle is the plot the layout chose the axis for.
 */
import { describe, expect, it } from 'vitest';
import { waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import { waterfallLayout } from '@/modules/accounting/services/packs/packWaterfallDomain';
import { PX_PER_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { bars, clipRect, figures, outsideClip, wrongSide } from './support/bridgeSvg';
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
    const failures = { offPlot: 0, wrongSide: 0, pitch: 0, plotMismatch: 0, unread: 0 };
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
        if (step.end !== step.start && wrongSide(figure, drawn[k]!, step.end > step.start)) {
          note('wrongSide', `${tag} "${figure.text}" at ${figure.y}, bar ${drawn[k]!.top}–${drawn[k]!.bottom}`);
        }
      });
      const ticks = yAxisTicks(svg);
      if (ticks.length > 1 && clip.height / (ticks.length - 1) < MIN_PITCH_PX - 0.01) {
        note('pitch', `${tag} ${ticks.length} ticks in ${clip.height}px`);
      }
    }
    expect(failures, examples.join('\n')).toEqual({ offPlot: 0, wrongSide: 0, pitch: 0, plotMismatch: 0, unread: 0 });
  }, 300_000);
});
