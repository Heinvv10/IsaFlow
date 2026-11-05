/**
 * Page 6 inputs shaped like the adversarial review's grid for #1148: the sign/scale shapes of
 * `page6Shapes.ts` crossed with budget on/off, a prior column on/off and three trend series.
 */
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
