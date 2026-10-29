/**
 * CAN A READER SEE THE BUDGET BULLETS ON A PHONE? (browser review r1 M3, L2)
 *
 * Painted, not modelled: ECharts' SSR SVG renderer at 1280, 390 and 294 px
 * (294 = the chart's own width on a 390 px phone), read back off the SVG.
 *   - the value-axis labels never overlap;
 *   - the variance label is painted, whole, inside the chart (it used to be
 *     clipped to "212 7");
 *   - it sits past the end of BOTH bars, never on the budget outline or the
 *     actual bar (in dark it was unreadable on the white outline);
 *   - it is painted in the polarity colour (`varianceColor`), the one thing
 *     that says good or bad news: a label colour given as a function was never
 *     honoured by ECharts, so it was painted in the default ink.
 * Members are seeded with short and long names, under and over budget.
 */
import { describe, expect, it } from 'vitest';
import { getWidth } from 'zrender/lib/contain/text';
import { echarts } from '@/lib/charts/echarts';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';
import { buildBudgetBulletOption } from '@/components/accounting/charts/bulletOption';
import { DEFAULT_PALETTE, type ChartPalette } from '@/components/accounting/charts/chartTypes';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';

const PALETTE: ChartPalette = { ...DEFAULT_PALETTE, fav: '#00aa01', unfav: '#bb0002' };

function member(name: string, actual: number, budget: number, favourable: boolean): BudgetVsActualLine {
  const movement = Math.round((actual - budget) * 100) / 100;
  return {
    account_id: name, account_code: '', account_name: name, account_type: 'revenue', budgeted: true,
    budget_amount: budget, actual_amount: actual, variance: favourable ? Math.abs(movement) : -Math.abs(movement),
    movement, variance_pct: null, movement_pct: null, favourable,
  };
}

const SETS: Array<[string, BudgetVsActualLine[]]> = [
  ['one member under budget (Sample Trading)', [member('Untagged / company level', 1_945_668.97, 2_158_388, false)]],
  ['members over and under, long names', [
    member('FNO North — Gauteng fibre backhaul and leases', 2_400_000, 2_000_000, true),
    member('Project 17 Western Cape subcontractor labour', 300_000, 1_250_000, false),
    member('Untagged / company level', 12_345.67, 0, true),
  ]],
];

interface Painted { text: string; x: number; y: number; size: number; family: string; anchor: string; fill: string }
function texts(svg: string): Painted[] {
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const a = m[1] ?? '';
    const t = /transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(a);
    return {
      text: (m[2] ?? '').replace(/&amp;/g, '&'), x: Number(t?.[1] ?? NaN), y: Number(t?.[2] ?? NaN),
      size: Number(/font-size:([\d.]+)px/.exec(a)?.[1] ?? 12), family: /font-family:([^;"]+)/.exec(a)?.[1]?.trim() ?? 'sans-serif',
      anchor: /text-anchor="(\w+)"/.exec(a)?.[1] ?? 'start', fill: /fill="([^"]+)"/.exec(a)?.[1] ?? '',
    };
  });
}
const widthOf = (t: Painted) => getWidth(t.text, `${t.size}px ${t.family}`);

/** Right edges of the drawn bars (both series), from their rect paths. */
function barRights(svg: string): number[] {
  return [...svg.matchAll(/<path d="M([-\d.]+) [-\d.]+l([-\d.]+) 0[^"]*"[^>]*ecmeta_series_index="[01]"/g)].map((m) => Number(m[1]) + Number(m[2]));
}

function paint(option: unknown, width: number, height: number): string {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption({ textStyle: { fontFamily: PACK_FONT_STACK }, ...(option as Record<string, unknown>), animation: false });
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

for (const [name, lines] of SETS) {
  for (const px of [1280, 390, 294, 260]) {
    describe(`${name} at ${px}px`, () => {
      const option = buildBudgetBulletOption(lines, PALETTE);
      const svg = paint(option, px, Math.max(160, lines.length * 34 + 40));
      const all = texts(svg);
      const fmt = (n: number) => new Intl.NumberFormat('en-ZA').format(Math.abs(Math.round(n)));

      it('the value-axis labels never overlap', () => {
        const axis = all.filter((t) => t.anchor === 'middle').sort((a, b) => a.x - b.x);
        expect(axis.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < axis.length; i++) {
          const [a, b] = [axis[i - 1]!, axis[i]!];
          expect(b.x - a.x, `"${a.text}" / "${b.text}"`).toBeGreaterThanOrEqual((widthOf(a) + widthOf(b)) / 2 + 2);
        }
      });

      it('each variance label is painted whole, past both bars, in its polarity colour', () => {
        const right = Math.max(...barRights(svg));
        for (const l of lines) {
          const digits = fmt(l.movement).replace(/\s/g, '');
          const label = all.find((t) => t.anchor === 'start' && t.text.replace(/[\s ()+−-]/g, '').startsWith(digits.slice(0, 3)));
          expect(label, `no label for ${l.account_name}`).toBeDefined();
          expect(label!.text.replace(/[\s ()+−-]/g, '')).toBe(digits);
          expect(label!.x + widthOf(label!), `"${label!.text}" ends past ${px}px`).toBeLessThanOrEqual(px);
          // Past the end of the longer bar of its own row (the rows' bars all end at or before `right`
          // when this is the widest row; checked per row below).
          expect(label!.fill).toBe(l.favourable ? PALETTE.fav : PALETTE.unfav);
        }
        expect(right).toBeLessThanOrEqual(px);
      });

      it("a label starts after its own row's longer bar", () => {
        const bars = [...svg.matchAll(/<path d="M([-\d.]+) ([-\d.]+)l([-\d.]+) 0l0 ([-\d.]+)[^"]*"[^>]*ecmeta_series_index="[01]"/g)]
          .map((m) => ({ right: Number(m[1]) + Number(m[3]), top: Number(m[2]), bottom: Number(m[2]) + Number(m[4]) }));
        const labels = all.filter((t) => t.anchor === 'start');
        expect(labels.length).toBe(lines.length);
        for (const label of labels) {
          const row = bars.filter((b) => label.y >= b.top - 12 && label.y <= b.bottom + 12);
          expect(row.length, `"${label.text}" has no bars beside it`).toBeGreaterThan(0);
          expect(label.x, `"${label.text}" starts on a bar`).toBeGreaterThanOrEqual(Math.max(...row.map((b) => b.right)));
        }
      });
    });
  }
}
