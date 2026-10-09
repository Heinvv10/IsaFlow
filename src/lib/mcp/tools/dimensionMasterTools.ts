/**
 * MCP tools for the dimension masters: CC1 (FNO / client) and CC2 (project)
 * cost centres with parents and aliases, and business units with a division.
 *
 * Reads are free and unscoped beyond read:reports, like list_gl_accounts. The
 * creates post nothing, so they are `write` but not `requiresPost`, on the same
 * write:accounts scope as create_gl_account — chart-of-accounts master data.
 */
import type { McpTool } from '../types';
import {
  applyCreateDimensionCostCentre, listDimensionCostCentres, planCreateDimensionCostCentre, type DimensionCcType,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterService';
import {
  applyCreateBusinessUnit, BusinessUnitActionError, getBusinessUnits, planCreateBusinessUnit, type BusinessUnitInput,
} from '@/modules/accounting/services/core/businessUnitService';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { ok, strArg, toolError } from './toolHelpers';

const CC_TYPES: readonly DimensionCcType[] = ['cc1', 'cc2'];

export const listCostCentresTool: McpTool = {
  name: 'list_cost_centres',
  description:
    'List the cost-centre dimension master: CC1 = FNO / client, CC2 = project. Each row carries its parent code, '
    + 'the FNO (CC1) code a CC2 rolls up to, and its aliases. Use the code (or an alias) as cc1 / cc2 on any capture tool.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      cc_type: { type: 'string', enum: [...CC_TYPES] },
      include_inactive: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ccType = strArg(args, 'cc_type');
    if (ccType !== undefined && !(CC_TYPES as readonly string[]).includes(ccType)) {
      return toolError(`cc_type must be one of: ${CC_TYPES.join(', ')}`);
    }
    const rows = await listDimensionCostCentres(ctx.companyId, {
      ccType: ccType as DimensionCcType | undefined, includeInactive: args.include_inactive === true,
    });
    return ok({
      total: rows.length,
      cost_centres: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, cc_type: r.ccType, is_active: r.isActive,
        parent_code: r.parentCode, fno_code: r.fnoCode, aliases: r.aliases,
      })),
    });
  },
};

export const listBusinessUnitsTool: McpTool = {
  name: 'list_business_units',
  description: 'List the business units (BU = function, e.g. Civils, Build, Maintenance) with their division. Use the code as bu.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: { include_inactive: { type: 'boolean' } },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const rows = await getBusinessUnits(ctx.companyId, args.include_inactive !== true);
    return ok({
      total: rows.length,
      business_units: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, division: r.division ?? null, is_active: r.isActive,
      })),
    });
  },
};

function parseAliases(raw: unknown): string[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50) return 'aliases must be an array of at most 50 strings';
  const out: string[] = [];
  for (const [i, a] of raw.entries()) {
    if (typeof a !== 'string' || !a.trim()) return `aliases[${i}] must be a non-empty string`;
    out.push(a);
  }
  return out;
}

export const createCostCentreTool: McpTool = {
  name: 'create_cost_centre',
  description:
    'Create a CC1 (FNO / client) or CC2 (project) cost centre. A CC1 takes no parent. A CC2\'s parent (code, UUID or '
    + 'alias) is its CC1, or a programme CC2 whose chain reaches a CC1 — that is how its FNO is derived. aliases are '
    + 'alternative spellings ("Ben Farms", "Mafikeng") that resolve to this cost centre wherever cc1 / cc2 is accepted; '
    + 'an alias already used, or equal to another cost centre\'s code, is refused. Posts nothing.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', maxLength: 20 },
      name: { type: 'string', maxLength: 255 },
      cc_type: { type: 'string', enum: [...CC_TYPES] },
      parent: { type: 'string', description: 'CC2 only: the parent CC1 or programme CC2 (code, UUID or alias).' },
      aliases: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['code', 'name', 'cc_type', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const code = strArg(args, 'code');
    const name = strArg(args, 'name');
    const ccType = strArg(args, 'cc_type');
    if (!code || !name) return toolError('code and name are required');
    if (!ccType || !(CC_TYPES as readonly string[]).includes(ccType)) return toolError(`cc_type must be one of: ${CC_TYPES.join(', ')}`);
    const aliases = parseAliases(args.aliases);
    if (typeof aliases === 'string') return toolError(aliases);
    let plan: Awaited<ReturnType<typeof planCreateDimensionCostCentre>>;
    try {
      plan = await planCreateDimensionCostCentre(ctx.companyId, {
        code, name, ccType: ccType as DimensionCcType, parent: strArg(args, 'parent'), aliases,
      });
    } catch (err) {
      if (isDimensionRefusal(err)) return toolError(err.message);
      throw err;
    }
    const summary = {
      code: plan.input.code, cc_type: plan.input.ccType, fno_code: plan.fnoCode,
      aliases: plan.aliases.map((a) => a.alias),
      ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
    };
    if (args.dry_run === true) {
      const preview = ok({ dry_run: true, ...summary });
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }
    const created = await applyCreateDimensionCostCentre(ctx.companyId, plan, ctx.userId);
    return ok({ id: created.id, ...summary });
  },
};

export const createBusinessUnitTool: McpTool = {
  name: 'create_business_unit',
  description: 'Create a business unit (BU = function, e.g. MAINT "Maintenance") with an optional division. Posts nothing.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', maxLength: 20 },
      name: { type: 'string', maxLength: 255 },
      division: { type: 'string', maxLength: 120 },
      description: { type: 'string' },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['code', 'name', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const code = strArg(args, 'code');
    const name = strArg(args, 'name');
    if (!code || !name) return toolError('code and name are required');
    // Lengths and the case-insensitive code clash: the service's, shared with the route.
    let plan: BusinessUnitInput;
    try {
      plan = await planCreateBusinessUnit(ctx.companyId, {
        code, name, division: strArg(args, 'division'), description: strArg(args, 'description'),
      });
    } catch (err) {
      if (err instanceof BusinessUnitActionError) return toolError(err.message);
      throw err;
    }
    if (args.dry_run === true) {
      const preview = ok({ dry_run: true, code: plan.code, name: plan.name, division: plan.division ?? null });
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }
    const bu = await applyCreateBusinessUnit(ctx.companyId, plan);
    return ok({ id: bu.id, code: bu.code, name: bu.name, division: bu.division ?? null });
  },
};
