// Admin Analytics "MRR by Plan" (WP13, admin audit 4.5): each bar gets its colour from a <Cell>. Recharts' Bar
// collects its Cells by component type (findAllByType), so a Cell loaded through next/dynamic is a different
// type, the fills were ignored and every bar rendered black. This reads the element tree the chart returns and
// checks that Bar's children are recharts' own Cell, each with its own fill.
import { describe, expect, it } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Cell } from 'recharts';
import { PlanBreakdownChart } from '@/components/admin/charts/PlanBreakdownChart';

type El = ReactElement<{ children?: ReactNode; dataKey?: string; fill?: string }>;

function findBar(node: ReactNode): El | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const el = child as El;
    if (el.props.dataKey === 'mrr_cents' && el.props.children) return el;
    const inner = findBar(el.props.children);
    if (inner) return inner;
  }
  return null;
}

describe('PlanBreakdownChart', () => {
  it("gives Bar one recharts Cell per row, each with its own fill", () => {
    const tree = PlanBreakdownChart({ data: [
      { plan_name: 'Starter', billing_cycle: 'monthly', mrr_cents: 100000, pct_of_total: 60, company_count: 3 },
      { plan_name: 'Pro', billing_cycle: 'annual', mrr_cents: 50000, pct_of_total: 40, company_count: 1 },
    ] as never });
    const bar = findBar(tree);
    expect(bar).not.toBeNull();
    const cells = Children.toArray(bar!.props.children).filter(isValidElement) as El[];
    expect(cells.map((c) => c.type === Cell)).toEqual([true, true]);
    expect(cells.map((c) => c.props.fill)).toEqual(['#14b8a6', '#3b82f6']);
  });
});
