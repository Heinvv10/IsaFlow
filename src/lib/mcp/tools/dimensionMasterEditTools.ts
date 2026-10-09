/**
 * MCP edit / deactivate / delete for the dimension masters — the other half of
 * dimensionMasterTools' creates. Same scope (write:accounts) and same billing
 * (master data posts nothing). Every tool takes dry_run; every refusal comes
 * from reads before the first write, under the company's dimension-master lock
 * (taken by each plan, dry_run included). A refusal the apply raises (a 23505 or
 * 23503 from a writer outside the lock) is answered only after the service's
 * own savepoint has rolled the write back, so nothing half-written survives it.
 */
import type { McpTool, McpToolResult } from '../types';
import {
  applyDeleteDimensionCostCentre, applyUpdateDimensionCostCentre, planDeleteDimensionCostCentre,
  planUpdateDimensionCostCentre, type UpdateDimensionCostCentreInput,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterEdit';
import {
  applyUpdateBusinessUnit, BusinessUnitActionError, deleteBusinessUnit, planDeleteBusinessUnit,
  planUpdateBusinessUnit, type BusinessUnitUpdate,
} from '@/modules/accounting/services/core/businessUnitService';
import { CostCentreActionError } from '@/modules/accounting/services/core/costCentreUsageGuard';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { ok, strArg, toolError } from './toolHelpers';

/** The refusals written for the operator; anything else is a real failure and propagates. */
function refusal(err: unknown): McpToolResult {
  if (isDimensionRefusal(err) || err instanceof CostCentreActionError || err instanceof BusinessUnitActionError) {
    return toolError(err.message);
  }
  throw err;
}

function preview(data: Record<string, unknown>): McpToolResult {
  const r = ok({ dry_run: true, ...data });
  r.wroteNothing = true;
  r.billable = false;
  return r;
}

/** undefined = absent; null = clear; a string = set. Anything else is a caller error. */
function nullableStr(args: Record<string, unknown>, key: string): string | null | undefined | Error {
  const v = args[key];
  if (v === undefined || v === null) return v as null | undefined;
  return typeof v === 'string' ? v : new Error(`${key} must be a string or null`);
}

function stringList(args: Record<string, unknown>, key: string): string[] | undefined | Error {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 50 || v.some((a) => typeof a !== 'string' || !a.trim())) {
    return new Error(`${key} must be an array of at most 50 non-empty strings`);
  }
  return v as string[];
}

const REF = { type: 'string', description: 'Code, UUID or alias of the cost centre.' };

export const updateCostCentreTool: McpTool = {
  name: 'update_cost_centre',
  description:
    'Edit a CC1 (FNO) or CC2 (project): code, name, parent (CC2 only; null detaches), aliases (replace the set, or '
    + 'add_aliases / remove_aliases), description, department, is_active. Send only what changes. Refused: a parent '
    + 'loop, an inactive or FNO-less parent, a code/alias already used elsewhere, deactivating a node with active '
    + 'children, and moving a CC2 to another FNO while any line, document, default or tag batch carries it (re-tag '
    + 'first). Tagged lines keep their ids, so a rename re-labels history without moving any figure. Posts nothing.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      cost_centre: REF,
      code: { type: 'string', maxLength: 20 },
      name: { type: 'string', maxLength: 255 },
      parent: { type: ['string', 'null'], description: 'CC2 only: new parent CC1 or programme CC2; null detaches.' },
      aliases: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Replaces the whole alias set.' },
      add_aliases: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      remove_aliases: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      description: { type: ['string', 'null'] },
      department: { type: ['string', 'null'], maxLength: 100 },
      is_active: { type: 'boolean' },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['cost_centre', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ref = strArg(args, 'cost_centre');
    if (!ref) return toolError('cost_centre is required');
    if (args.aliases !== undefined && (args.add_aliases !== undefined || args.remove_aliases !== undefined)) {
      return toolError('send aliases (replace the set) or add_aliases / remove_aliases, not both');
    }
    if (args.is_active !== undefined && typeof args.is_active !== 'boolean') return toolError('is_active must be true or false');
    const fields = {
      parent: nullableStr(args, 'parent'), description: nullableStr(args, 'description'),
      department: nullableStr(args, 'department'), aliases: stringList(args, 'aliases'),
      addAliases: stringList(args, 'add_aliases'), removeAliases: stringList(args, 'remove_aliases'),
    };
    for (const v of Object.values(fields)) if (v instanceof Error) return toolError(v.message);
    const input = {
      code: strArg(args, 'code'), name: strArg(args, 'name'),
      ...fields, isActive: args.is_active as boolean | undefined,
    } as UpdateDimensionCostCentreInput;
    let plan: Awaited<ReturnType<typeof planUpdateDimensionCostCentre>>;
    try {
      plan = await planUpdateDimensionCostCentre(ctx.companyId, ref, input);
    } catch (err) {
      return refusal(err);
    }
    if (plan.changed.length === 0) return toolError('Nothing to change');
    const a = plan.after;
    const summary = {
      id: plan.before.id, code: a.code, name: a.name, cc_type: plan.before.ccType, parent_code: a.parentCode,
      fno_code: a.fnoCode, is_active: a.isActive, changed: plan.changed,
      aliases_added: plan.addAliases.map((x) => x.alias), aliases_removed: plan.removeAliasKeys,
      ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
    };
    if (args.dry_run === true) return preview(summary);
    try {
      await applyUpdateDimensionCostCentre(ctx.companyId, plan, ctx.userId);
    } catch (err) {
      return refusal(err);
    }
    return ok(summary);
  },
};

export const deleteCostCentreTool: McpTool = {
  name: 'delete_cost_centre',
  description:
    'Delete a CC1 / CC2 that nothing uses (its aliases go with it). Refused, with counts, while any journal line, '
    + 'bank line, document, child cost centre, customer/account default, payroll or asset record, or un-reversed tag '
    + 'batch still references it — deactivate it with update_cost_centre is_active=false instead. Posts nothing.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: { cost_centre: REF, dry_run: { type: 'boolean' }, idempotency_key: { type: 'string' } },
    required: ['cost_centre', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ref = strArg(args, 'cost_centre');
    if (!ref) return toolError('cost_centre is required');
    let target: Awaited<ReturnType<typeof planDeleteDimensionCostCentre>>;
    try {
      target = await planDeleteDimensionCostCentre(ctx.companyId, ref);
    } catch (err) {
      return refusal(err);
    }
    const summary = { id: target.id, code: target.code, cc_type: target.ccType, aliases: target.aliases };
    if (args.dry_run === true) return preview(summary);
    try {
      await applyDeleteDimensionCostCentre(ctx.companyId, target, ctx.userId);
    } catch (err) {
      return refusal(err);
    }
    return ok({ deleted: true, ...summary });
  },
};

export const updateBusinessUnitTool: McpTool = {
  name: 'update_business_unit',
  description:
    'Edit a business unit: code, name, division (null clears), description (null clears), is_active. Send only what '
    + 'changes. A code already used by another BU is refused. Tagged lines keep their ids, so a rename re-labels '
    + 'history without moving any figure. Posts nothing.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      business_unit: { type: 'string', description: 'Code or UUID of the business unit.' },
      code: { type: 'string', maxLength: 20 },
      name: { type: 'string', maxLength: 255 },
      division: { type: ['string', 'null'], maxLength: 120 },
      description: { type: ['string', 'null'] },
      is_active: { type: 'boolean' },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['business_unit', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ref = strArg(args, 'business_unit');
    if (!ref) return toolError('business_unit is required');
    if (args.is_active !== undefined && typeof args.is_active !== 'boolean') return toolError('is_active must be true or false');
    const division = nullableStr(args, 'division');
    const description = nullableStr(args, 'description');
    if (division instanceof Error) return toolError(division.message);
    if (description instanceof Error) return toolError(description.message);
    const input: BusinessUnitUpdate = {
      code: strArg(args, 'code'), name: strArg(args, 'name'), division, description,
      isActive: args.is_active as boolean | undefined,
    };
    let plan: Awaited<ReturnType<typeof planUpdateBusinessUnit>>;
    try {
      plan = await planUpdateBusinessUnit(ctx.companyId, ref, input);
    } catch (err) {
      return refusal(err);
    }
    if (plan.changed.length === 0) return toolError('Nothing to change');
    const a = plan.after;
    const summary = {
      id: plan.before.id, code: a.code, name: a.name, division: a.division, description: a.description,
      is_active: a.isActive, changed: plan.changed,
    };
    if (args.dry_run === true) return preview(summary);
    try {
      await applyUpdateBusinessUnit(ctx.companyId, plan);
    } catch (err) {
      return refusal(err);
    }
    return ok(summary);
  },
};

export const deleteBusinessUnitTool: McpTool = {
  name: 'delete_business_unit',
  description:
    'Delete a business unit that nothing uses. Refused, with counts, while any journal line, bank line, document '
    + 'line, account default or un-reversed tag batch still carries it — deactivate it with update_business_unit '
    + 'is_active=false instead. Posts nothing.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      business_unit: { type: 'string', description: 'Code or UUID of the business unit.' },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['business_unit', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ref = strArg(args, 'business_unit');
    if (!ref) return toolError('business_unit is required');
    let bu: Awaited<ReturnType<typeof planDeleteBusinessUnit>>;
    try {
      bu = await planDeleteBusinessUnit(ctx.companyId, ref);
    } catch (err) {
      return refusal(err);
    }
    const summary = { id: bu.id, code: bu.code, name: bu.name };
    if (args.dry_run === true) return preview(summary);
    try {
      await deleteBusinessUnit(ctx.companyId, bu.id);
    } catch (err) {
      return refusal(err);
    }
    return ok({ deleted: true, ...summary });
  },
};
