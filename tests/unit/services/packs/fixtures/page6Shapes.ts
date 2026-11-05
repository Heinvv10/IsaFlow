/**
 * The demo company re-shaped across page 6's crowding axes: scale, sign of every income-statement
 * line, a loss, a net-debit revenue and an unexplained interest/tax step. 2,560 inputs. Taken from
 * the adversarial review of #1121 (advSigns), which is where both fitter defects were found.
 */
import { demoInput, demoSet } from './boardPackInputs';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/packBoardPackInput';

export interface Page6Shape { k: number; negative: boolean; loss: boolean; plug: number; sg: number[] }

export function page6Input({ k, negative, loss, plug, sg }: Page6Shape): BoardPackInput {
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
  return { ...demoInput, set: { ...demoSet, current: { ...current, operatingProfit: op, netProfit }, prior, budget: { ...demoSet.budget!, bands } } };
}

const SCALES = [1, 30, 300, 1000, 1220, 2000, 3000, 7000, 30000, 300000];
const PLUGS = [0, 0.03, 0.05, 0.2];

/** All 2,560 shapes: 2 (net-debit revenue) x 2 (loss) x 10 scales x 4 plugs x 16 sign patterns. */
export function allPage6Shapes(): Page6Shape[] {
  const signs = Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].map((b) => (((i >> b) & 1) ? -1 : 1)));
  const out: Page6Shape[] = [];
  for (const negative of [true, false]) for (const loss of [false, true]) for (const k of SCALES) {
    for (const plug of PLUGS) for (const sg of signs) out.push({ k, negative, loss, plug, sg });
  }
  return out;
}
