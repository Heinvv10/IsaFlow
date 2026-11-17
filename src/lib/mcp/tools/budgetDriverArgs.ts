/**
 * set_budget_drivers' `changes` (budget tools PR 3): each change to the input the app's driver route hands its
 * service (pages/api/accounting/budget-drivers/{index,override,planned-hires,headcount}.ts: the same fields, the
 * same defaults), or a refusal naming the change. Accounts and dimension members by id or code through PR 1's
 * resolver (budgetRefResolve: unknown, ambiguous, header, inactive and non-income-statement accounts refused,
 * at most one dimension: decision 14); cost centres (headcount scope, a hire's centre) by id or code over the
 * company's CC1 and CC2 centres; driver amounts decimal strings; months YYYY-MM. Pure apart from the resolver's
 * one chart read: nothing here writes.
 */
import { UUID_RE } from '@/lib/validation';
import { codeIndex } from '@/modules/accounting/services/budgets/codeIndex';
import { BAND_ORDER, type Band } from '@/modules/accounting/services/budgets/grid/subtotals';
import { ROUNDING_UNITS, type RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { DriverGrain, DriverLineInput, StoredDriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import type { PlannedHireInput } from '@/modules/accounting/services/budgets/drivers/driverRepository';
import type { McpToolContext } from '../types';
import { isMonth, parseMoney } from './budgetToolArgs';
import { resolveRows, type RowRef } from './budgetCellArgs';

export const MAX_DRIVER_CHANGES = 50;
export const DRIVER_OPS = ['set_driver', 'delete_driver', 'reset_override', 'add_hire', 'update_hire', 'delete_hire', 'refresh_headcount'] as const;
export type DriverOp = typeof DRIVER_OPS[number];
const KINDS = ['fixed', 'per_head', 'pct_of_line', 'pct_of_section', 'growth'] as const;

export type DriverChange =
  | { index: number; op: 'set_driver'; line: DriverLineInput }
  | { index: number; op: 'delete_driver'; driverId: string; grain: DriverGrain }
  | { index: number; op: 'reset_override'; grain: DriverGrain; month: string | null }
  | { index: number; op: 'add_hire'; hire: PlannedHireInput }
  | { index: number; op: 'update_hire'; hireId: string; hire: PlannedHireInput }
  | { index: number; op: 'delete_hire'; hireId: string }
  | { index: number; op: 'refresh_headcount' };

export interface ChangeRefusal { i: number; op: string; reason: string }

const ROW = ['account', 'cc1', 'cc2', 'bu'];
const HIRE = ['label', 'cost_centre', 'start_month', 'end_month', 'fte'];
const FIELDS: Record<DriverOp, readonly string[]> = {
  set_driver: [...ROW, 'kind', 'from_month', 'to_month', 'rounding_unit', 'amount', 'pct', 'ref', 'section', 'scope', 'base_month', 'headcount_cost_centre'],
  delete_driver: ROW,
  reset_override: [...ROW, 'month'],
  add_hire: HIRE,
  update_hire: ['hire_id', ...HIRE],
  delete_hire: ['hire_id'],
  refresh_headcount: [],
};

class Refused extends Error {}
const refuse = (reason: string): never => { throw new Refused(reason); };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const month = (o: Record<string, unknown>, k: string): string => (isMonth(o[k]) ? o[k] as string : refuse(`${k} must be YYYY-MM`));
const optMonth = (o: Record<string, unknown>, k: string): string | null => (o[k] === undefined || o[k] === null ? null : month(o, k));
const num = (o: Record<string, unknown>, k: string): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? o[k] as number : refuse(`${k} must be a number`));

/** A cost centre (CC1 or CC2) by id or code: its id, null when absent, or why it cannot be one. */
export function resolveCentre(model: GridReadModel, v: unknown, what: string): { id: string | null } | { reason: string } {
  if (v === undefined || v === null) return { id: null };
  if (typeof v !== 'string' || v.trim() === '') return { reason: `${what} must be a cost centre id or code` };
  if (UUID_RE.test(v)) return { id: v.toLowerCase() };
  const found = codeIndex([...model.dimensions.cc1, ...model.dimensions.cc2])(v);
  if (found === null) return { reason: `cost centre code ${v.slice(0, 40)} matches more than one cost centre; name it by id` };
  return found === undefined ? { reason: `${v.slice(0, 40)} is not one of this company's active cost centres` } : { id: found.id };
}

function centreResolver(model: GridReadModel) {
  return (o: Record<string, unknown>, k: string): string | null => {
    const r = resolveCentre(model, o[k], k);
    return 'reason' in r ? refuse(r.reason) : r.id;
  };
}

/** Each change as its service input, or its refusal. `lines` are the version's stored driver lines (delete_driver names a row). */
export async function parseDriverChanges(
  ctx: McpToolContext, model: GridReadModel, lines: readonly StoredDriverLine[], raw: readonly unknown[],
): Promise<{ changes: DriverChange[]; refusals: ChangeRefusal[] }> {
  const items = raw.map(obj);
  const rows: RowRef[] = [];
  items.forEach((o, i) => {
    if (ROW.some((k) => k in o)) rows.push({ index: i * 2, account: o.account, cc1: o.cc1, cc2: o.cc2, bu: o.bu });
    const ref = obj(o.ref);
    if (o.ref !== undefined) rows.push({ index: i * 2 + 1, account: ref.account, cc1: ref.cc1, cc2: ref.cc2, bu: ref.bu });
  });
  const refs = await resolveRows(ctx, model, rows);
  const grainOf = (index: number, what: string): DriverGrain => {
    const r = refs.get(index);
    if (!r) return refuse(`${what} is required (an account id or code)`);
    return 'glAccountId' in r ? r : refuse(`${what}: ${r.reason}`);
  };
  const centre = centreResolver(model);
  const hireOf = (o: Record<string, unknown>): PlannedHireInput => ({
    label: typeof o.label === 'string' ? o.label : refuse('label must be text (a role, never a person\'s name)'),
    costCentreId: centre(o, 'cost_centre'), startMonth: month(o, 'start_month'), endMonth: optMonth(o, 'end_month'),
    fte: o.fte === undefined ? 1 : num(o, 'fte'),
  });
  const hireId = (o: Record<string, unknown>): string => (typeof o.hire_id === 'string' && UUID_RE.test(o.hire_id) ? o.hire_id.toLowerCase() : refuse('hire_id must be a planned hire id'));
  const changes: DriverChange[] = [];
  const refusals: ChangeRefusal[] = [];
  items.forEach((o, i) => {
    const op = o.op as DriverOp;
    try {
      if (!(DRIVER_OPS as readonly unknown[]).includes(op)) refuse(`op must be one of ${DRIVER_OPS.join(', ')}`);
      const extra = Object.keys(o).find((k) => k !== 'op' && !FIELDS[op].includes(k));
      if (extra) refuse(`${extra.slice(0, 40)} is not a field of ${op}`);
      if (op === 'set_driver') changes.push({ index: i, op, line: driverLine(o, grainOf(i * 2, 'account'), () => grainOf(i * 2 + 1, 'ref'), centre) });
      else if (op === 'delete_driver') {
        const grain = grainOf(i * 2, 'account');
        const found = lines.find((d) => d.glAccountId === grain.glAccountId && d.cc1Id === grain.cc1Id && d.cc2Id === grain.cc2Id && d.buId === grain.buId);
        changes.push(found ? { index: i, op, driverId: found.id, grain } : refuse(`${String(o.account).slice(0, 40)} has no driver to delete at that level`));
      } else if (op === 'reset_override') changes.push({ index: i, op, grain: grainOf(i * 2, 'account'), month: optMonth(o, 'month') });
      else if (op === 'add_hire') changes.push({ index: i, op, hire: hireOf(o) });
      else if (op === 'update_hire') changes.push({ index: i, op, hireId: hireId(o), hire: hireOf(o) });
      else if (op === 'delete_hire') changes.push({ index: i, op, hireId: hireId(o) });
      else changes.push({ index: i, op: 'refresh_headcount' });
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      refusals.push({ i, op: typeof o.op === 'string' ? o.op.slice(0, 40) : String(o.op), reason: err.message });
    }
  });
  return { changes, refusals };
}

/** A set_driver change as the route's PUT body gives it to `saveDriver`: the kind's own fields, rounding R1 by default. */
function driverLine(
  o: Record<string, unknown>, grain: DriverGrain, ref: () => DriverGrain, centre: (o: Record<string, unknown>, k: string) => string | null,
): DriverLineInput {
  const kind = (KINDS as readonly unknown[]).includes(o.kind) ? o.kind as typeof KINDS[number] : refuse(`kind must be one of ${KINDS.join(', ')}`);
  const rounding = o.rounding_unit === undefined ? 1 : (ROUNDING_UNITS as readonly unknown[]).includes(o.rounding_unit) ? o.rounding_unit as RoundingUnit : refuse('rounding_unit must be 1, 100 or 1000');
  const need = (k: string) => (o[k] === undefined || o[k] === null ? refuse(`a ${kind} driver needs ${k}`) : o[k]);
  const base = { ...grain, kind, fromMonth: month(o, 'from_month'), toMonth: month(o, 'to_month'), rounding };
  const amount = () => {
    const money = parseMoney(need('amount'));
    return 'error' in money ? refuse(`amount: ${money.error}`) : money.cents / 100;
  };
  switch (kind) {
    case 'fixed': return { ...base, amount: amount() };
    case 'per_head': return { ...base, amount: amount(), headcountCostCentreId: centre(o, 'headcount_cost_centre') };
    case 'pct_of_line': need('pct'); need('ref'); return { ...base, pct: num(o, 'pct'), ref: ref() };
    case 'pct_of_section': {
      need('pct');
      const section = (BAND_ORDER as readonly unknown[]).includes(need('section')) ? o.section as Band : refuse(`section must be one of ${BAND_ORDER.join(', ')}`);
      const scope = o.scope === 'same_grain' || o.scope === 'company' ? o.scope : refuse('scope must be same_grain or company');
      return { ...base, pct: num(o, 'pct'), section, scope };
    }
    case 'growth': need('pct'); return { ...base, pct: num(o, 'pct'), baseMonth: month(o, 'base_month') };
  }
}
