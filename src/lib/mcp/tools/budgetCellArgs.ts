/**
 * The MCP budget tools' cell references: account by id or code, at most one dimension (cc1 | cc2 | bu, by
 * id or code; decision 14), resolved against the version's grid as the token user sees it with the Excel
 * import's code matching (`budgetRefResolve`). Every fault in ONE row (shape, month, amount, an account
 * or member that cannot be budgeted) is refused for that row with its reason, never guessed; the other
 * rows are still planned so a dry run shows every fault at once.
 */
import { explainMissingAccounts, refResolver, type DimensionKind } from '@/modules/accounting/services/budgets/budgetRefResolve';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PlanInput } from '@/modules/accounting/services/budgets/cellWritePlan';
import type { McpToolContext } from '../types';
import { isMonth, parseMoney } from './budgetToolArgs';
import type { RowRefusal } from './budgetDiffView';

export interface RowRef { index: number; account: unknown; cc1?: unknown; cc2?: unknown; bu?: unknown }

export type ResolvedRef = { glAccountId: string; cc1Id: string | null; cc2Id: string | null; buId: string | null };

const DIMS: readonly DimensionKind[] = ['cc1', 'cc2', 'bu'];
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The dimension a row names, as the agent wrote it (for messages), or null. */
export function dimensionLabel(r: RowRef): string | null {
  const kind = DIMS.find((d) => r[d] !== undefined && r[d] !== null);
  return kind ? `${kind} ${text(r[kind]) || String(r[kind])}` : null;
}

/** Each row's ids, or its refusal reason. One chart read for the accounts the grid does not list. */
export async function resolveRows(ctx: McpToolContext, model: GridReadModel, rows: readonly RowRef[]): Promise<Map<number, ResolvedRef | { reason: string }>> {
  const resolver = refResolver(model);
  const out = new Map<number, ResolvedRef | { reason: string }>();
  const missing = new Map<number, string>();
  for (const r of rows) {
    const account = text(r.account);
    if (account === '') { out.set(r.index, { reason: 'account is required (an account id or code)' }); continue; }
    const named = DIMS.filter((d) => r[d] !== undefined && r[d] !== null);
    if (named.length > 1) { out.set(r.index, { reason: 'A budget amount carries at most one dimension: cc1, cc2 or bu (decision 14)' }); continue; }
    const found = resolver.account(account);
    if (found === null) { missing.set(r.index, account); continue; }
    if (!found.ok) { out.set(r.index, { reason: found.reason }); continue; }
    const ref: ResolvedRef = { glAccountId: found.item.id, cc1Id: null, cc2Id: null, buId: null };
    const kind = named[0];
    if (kind) {
      const value = text(r[kind]);
      const member = value === '' ? { ok: false as const, reason: `${kind} must be an id or code` } : resolver.member(kind, value);
      if (!member.ok) { out.set(r.index, { reason: member.reason }); continue; }
      ref[kind === 'cc1' ? 'cc1Id' : kind === 'cc2' ? 'cc2Id' : 'buId'] = member.item.id;
    }
    out.set(r.index, ref);
  }
  const reasons = await explainMissingAccounts(ctx.companyId, [...new Set(missing.values())]);
  for (const [index, account] of missing) out.set(index, { reason: reasons.get(account) ?? `${account} cannot be budgeted` });
  return out;
}

const isResolved = (v: ResolvedRef | { reason: string } | undefined): v is ResolvedRef => v !== undefined && 'glAccountId' in v;

/** set_budget_amounts' `cells`: each to a plan input, or a refused row. */
export async function parseAmountCells(
  ctx: McpToolContext, model: GridReadModel, cells: readonly unknown[],
): Promise<{ inputs: PlanInput[]; refusals: RowRefusal[] }> {
  const months = new Set(model.year.monthKeys);
  const rows: Array<RowRef & { month: unknown; amount: unknown }> = cells.map((c, index) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    return { index, account: o.account, cc1: o.cc1, cc2: o.cc2, bu: o.bu, month: o.month, amount: o.amount };
  });
  const refs = await resolveRows(ctx, model, rows);
  const inputs: PlanInput[] = [];
  const refusals: RowRefusal[] = [];
  for (const r of rows) {
    const refuse = (reason: string) => refusals.push({ index: r.index, account: text(r.account), month: String(r.month ?? ''), dimension: dimensionLabel(r), reason });
    if (!isMonth(r.month)) { refuse('month must be YYYY-MM'); continue; }
    if (!months.has(r.month)) {
      refuse(`${r.month} is not a month of FY${model.year.fiscalYear} (${model.year.monthKeys[0]} to ${model.year.monthKeys[model.year.monthKeys.length - 1]})`);
      continue;
    }
    let cents: number | null = null;
    if (r.amount !== null) {
      const money = parseMoney(r.amount);
      if ('error' in money) { refuse(money.error); continue; }
      cents = money.cents;
    }
    const ref = refs.get(r.index);
    if (!isResolved(ref)) { refuse(ref?.reason ?? 'unresolved'); continue; }
    inputs.push({ index: r.index, ...ref, month: r.month, cents });
  }
  return { inputs, refusals };
}
