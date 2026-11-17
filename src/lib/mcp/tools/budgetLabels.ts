/**
 * How the MCP budget tools name what a version's grid lists (budget tools PR 3; shared by the driver, remaining and
 * diff answers): accounts and dimension members by code, a cost centre (CC1 or CC2) by code, the id where the grid
 * does not list it. Pure.
 */
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { DriverGrain } from '@/modules/accounting/services/budgets/drivers/driverLine';

export interface BudgetLabels {
  account(id: string): string;
  /** `{ level, member }` of a grain: company level, or one cc1 / cc2 / bu member by code. */
  grain(g: Pick<DriverGrain, 'cc1Id' | 'cc2Id' | 'buId'>): { level: 'company' | 'cc1' | 'cc2' | 'bu'; member: string | null };
  /** A cost centre (CC1 or CC2: headcount and hires name either) by code, the id when the grid does not list it. */
  centre(id: string | null): string | null;
}

export function budgetLabels(model: GridReadModel): BudgetLabels {
  const accounts = new Map(model.accounts.map((a) => [a.id, a.code]));
  const members = new Map<string, string>();
  for (const kind of ['cc1', 'cc2', 'bu'] as const) for (const m of model.dimensions[kind]) members.set(`${kind}:${m.id}`, m.code);
  const centres = new Map([...model.dimensions.cc1, ...model.dimensions.cc2].map((m) => [m.id, m.code]));
  return {
    account: (id) => accounts.get(id) ?? id,
    grain: (g) => {
      const [level, id] = g.cc1Id ? ['cc1', g.cc1Id] as const : g.cc2Id ? ['cc2', g.cc2Id] as const : g.buId ? ['bu', g.buId] as const : ['company', null] as const;
      return { level, member: id === null ? null : members.get(`${level}:${id}`) ?? id };
    },
    centre: (id) => (id === null ? null : centres.get(id) ?? id),
  };
}
