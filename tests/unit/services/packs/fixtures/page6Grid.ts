/**
 * The adversarial review's 11,520-input grid for page 6 (#1148): the 2,560 sign/scale shapes of
 * `page6Shapes.ts` crossed with budget on/off, a prior column on/off and three trend series.
 * Taken from /home/hein/audit-archive/p3fu/adv-1148/tests/unit/adv1148/advInputs.ts.
 */
import { createHash } from 'node:crypto';
import { demoInput, demoSet, trend, zeroRevenueTrend } from './boardPackInputs';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/packBoardPackInput';

export interface Shape { k: number; negative: boolean; loss: boolean; plug: number; sg: number[]; budget: boolean; prior: boolean; tr: 'demo' | 'none' | 'zero' }

export function input({ k, negative, loss, plug, sg, budget, prior: withPrior, tr }: Shape): BoardPackInput {
  const c = demoSet.current;
  const m = (v: number) => Math.round(v * k);
  const s = negative ? -1 : 1;
  const opexK = loss ? 2 : 1;
  const current = {
    ...c, revenue: m(c.revenue) * s, costOfSales: m(c.costOfSales) * sg[0]!, operatingExpenses: m(c.operatingExpenses) * opexK * sg[1]!,
    otherIncome: m(c.otherIncome ?? 0) * sg[2]!, otherExpenses: m(c.otherExpenses ?? 0) * sg[3]!,
  };
  const op = current.revenue - current.costOfSales + current.otherIncome - current.operatingExpenses;
  const b = demoSet.budget!.bands;
  const bands = {
    ...b, 'is.revenue': m(b['is.revenue']!) * s, 'is.costOfSales': m(b['is.costOfSales']!),
    'is.otherIncome': m(b['is.otherIncome']!), 'is.operatingExpenses': m(b['is.operatingExpenses']!) * opexK, 'is.otherExpenses': m(b['is.otherExpenses']!),
  };
  bands['is.grossProfit'] = bands['is.revenue'] - bands['is.costOfSales'];
  bands['is.operating'] = bands['is.grossProfit'] + bands['is.otherIncome'] - bands['is.operatingExpenses'];
  bands['is.netProfit'] = bands['is.operating'] - bands['is.otherExpenses'];
  const pr = demoSet.prior!;
  const prior = {
    ...pr, revenue: m(pr.revenue) * s, costOfSales: m(pr.costOfSales), operatingExpenses: m(pr.operatingExpenses),
    operatingProfit: m(pr.operatingProfit ?? 0), netProfit: m(pr.netProfit), otherIncome: m(pr.otherIncome ?? 0), otherExpenses: m(pr.otherExpenses ?? 0),
  };
  const netProfit = op - current.otherExpenses - Math.round(Math.abs(op) * plug);
  return {
    ...demoInput,
    trend: tr === 'demo' ? trend : tr === 'zero' ? zeroRevenueTrend : [],
    set: {
      ...demoSet,
      current: { ...current, operatingProfit: op, netProfit },
      prior: withPrior ? prior : null,
      budget: budget ? { ...demoSet.budget!, bands } : null,
    },
  };
}

export function allShapes(): Shape[] {
  const signs = Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].map((b) => (((i >> b) & 1) ? -1 : 1)));
  const out: Shape[] = [];
  for (const tr of ['demo', 'none', 'zero'] as const) for (const budget of [true, false]) for (const prior of [true, false])
    for (const negative of [true, false]) for (const loss of [false, true]) for (const k of [1, 30, 1000, 30000, 300000])
      for (const plug of [0, 0.05, 0.2]) for (const sg of signs) out.push({ k, negative, loss, plug, sg, budget, prior, tr });
  return out;
}

export function shard(): Shape[] {
  const n = Number(process.env.ADV_SHARDS ?? 1);
  const i = Number(process.env.ADV_SHARD ?? 0);
  return allShapes().filter((_, j) => j % n === i);
}

export const key = (s: Shape) => `tr=${s.tr} b=${+s.budget} p=${+s.prior} neg=${+s.negative} loss=${+s.loss} k=${s.k} plug=${s.plug} sg=${s.sg.join('')}`;

const ANCHOR_KEYS = new Set(['footnote', 'priorFootnote', 'trendFootnote']);

/** The page with every superscript replaced by the text it resolves to. */
export function resolved(page: { blocks: unknown[]; footnotes: Array<{ number: number; text: string }> }): unknown {
  const byNo = new Map<number, string[]>();
  for (const f of page.footnotes) byNo.set(f.number, [...(byNo.get(f.number) ?? []), f.text]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'droppable') continue;
        if (ANCHOR_KEYS.has(k) && typeof x === 'number') o[k] = `->${(byNo.get(x) ?? ['<NONE>']).join(' || ')}`;
        else o[k] = walk(x);
      }
      return o;
    }
    return v;
  };
  return { blocks: walk(page.blocks), footnotes: page.footnotes.map((f) => f.text) };
}

/** Everything but prose and superscripts: the figure-bearing blocks. */
export function figuresOf(page: { blocks: Array<{ kind: string }> }): unknown {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!ANCHOR_KEYS.has(k) && k !== 'droppable' && k !== 'columnNotes') o[k] = strip(x);
      return o;
    }
    return v;
  };
  return page.blocks.filter((b) => b.kind !== 'narrative' && b.kind !== 'disclosure').map(strip);
}

export const h = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);
