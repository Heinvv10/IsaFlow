/**
 * <Chart> props validation and geometry. Data shapes:
 *   single series:  [{ label: 'Jan', value: 12 }, ...]                  (bar, line, pie)
 *   multi series:   [{ label: 'Jan', values: { Sales: 12, Costs: 8 } }] (bar, line)
 * Every multi-series row must carry the same series keys. Pie values must be >= 0 with a
 * positive total. Invalid props throw, which fails the build for that post.
 */
import { z } from 'zod';

const finite = z.number().refine(Number.isFinite, 'must be a finite number');
const singleRow = z.object({ label: z.string().min(1), value: finite }).strict();
const multiRow = z.object({ label: z.string().min(1), values: z.record(z.string().min(1), finite) }).strict();

export const chartPropsSchema = z
  .object({
    type: z.enum(['bar', 'line', 'pie']),
    title: z.string().trim().min(1),
    source: z.string().trim().min(1),
    data: z.union([z.array(singleRow).min(1), z.array(multiRow).min(1)]),
    height: z.number().int().min(160).max(800).optional(),
    unit: z.string().max(8).optional(),
  })
  .superRefine((p, ctx) => {
    const first = p.data[0];
    if (first && 'values' in first) {
      if (p.type === 'pie') ctx.addIssue({ code: 'custom', path: ['data'], message: 'pie charts take single-series { label, value } rows' });
      const keys = Object.keys(first.values).sort().join('|');
      if (keys === '') ctx.addIssue({ code: 'custom', path: ['data', 0, 'values'], message: 'needs at least one series' });
      p.data.forEach((row, i) => {
        if ('values' in row && Object.keys(row.values).sort().join('|') !== keys) {
          ctx.addIssue({ code: 'custom', path: ['data', i, 'values'], message: 'every row must have the same series keys' });
        }
      });
    }
    if (p.type === 'pie') {
      const vals = p.data.map((r) => ('value' in r ? r.value : 0));
      if (vals.some((v) => v < 0)) ctx.addIssue({ code: 'custom', path: ['data'], message: 'pie values must be >= 0' });
      if (vals.reduce((a, b) => a + b, 0) <= 0) ctx.addIssue({ code: 'custom', path: ['data'], message: 'pie values must sum to more than 0' });
    }
  });

export type ChartProps = z.input<typeof chartPropsSchema>;

export interface NormalisedChart {
  type: 'bar' | 'line' | 'pie';
  title: string;
  source: string;
  height: number;
  unit: string;
  labels: string[];
  series: { name: string; values: number[] }[];
}

/** Validate and normalise to label + series arrays; throws a readable error. */
export function normaliseChart(raw: unknown): NormalisedChart {
  const r = chartPropsSchema.safeParse(raw);
  if (!r.success) {
    const t = typeof raw === 'object' && raw !== null && 'title' in raw ? String((raw as { title: unknown }).title) : '(untitled)';
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '(props)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid <Chart> "${t}": ${issues}`);
  }
  const p = r.data;
  const labels = p.data.map((d) => d.label);
  const first = p.data[0];
  const series =
    first && 'values' in first
      ? Object.keys(first.values).map((name) => ({
          name,
          values: p.data.map((d) => ('values' in d ? (d.values[name] ?? 0) : 0)),
        }))
      : [{ name: p.title, values: p.data.map((d) => ('value' in d ? d.value : 0)) }];
  return { type: p.type, title: p.title, source: p.source, height: p.height ?? 320, unit: p.unit ?? '', labels, series };
}

/** Round axis ticks covering [min, max], always including 0. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return [0, 1];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  if ((ticks[ticks.length - 1] ?? 0) < hi) ticks.push(Number((start + ticks.length * step).toFixed(10)));
  return ticks;
}

/** SVG path for a pie slice from angle a0 to a1 (radians, 0 = 12 o'clock, clockwise). */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-9) {
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
  }
  const pt = (a: number): string => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${pt(a0)} A ${r} ${r} 0 ${large} 1 ${pt(a1)} Z`;
}

export function formatChartValue(v: number, unit: string): string {
  const n = Math.abs(v) >= 1000 ? v.toLocaleString('en-ZA', { maximumFractionDigits: 1 }) : String(Number(v.toFixed(2)));
  if (!unit) return n;
  return unit === 'R' ? `R${n}` : `${n}${unit}`;
}

/** Light-theme palette led by the brand teal; every colour holds >= 3:1 contrast on white. */
export const CHART_COLOURS = ['#0d9488', '#2563eb', '#7c3aed', '#d97706', '#dc2626', '#475569', '#db2777', '#15803d'];
