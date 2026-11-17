/**
 * MCP read tool get_budget_drivers (budget tools PR 3): one version's driver lines, planned hires, headcount and
 * overrides, read through the services the app's driver routes read (`listDrivers`, `listHires`, `readHeadcount`)
 * and the grid read model (the override cells), as the token user. Per-head detail follows the app's rule
 * (decision 15 / #979, `perHeadAccessOf`): a per_head rate and the headcount counts go to budget writers (owner,
 * admin, manager) only; a reader gets the line without its rate and no counts. read:reports.
 */
import { listDrivers } from '@/modules/accounting/services/budgets/drivers/driverWriteService';
import { listHires, readHeadcount } from '@/modules/accounting/services/budgets/drivers/plannedHireService';
import { perHeadAccessOf, PER_HEAD_RESTRICTED_NOTE } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import type { McpTool } from '../types';
import { BUDGET_READ_SCOPE, centsText, isResult } from './budgetToolArgs';
import { loadModel } from './budgetAmountWrite';
import { resolveCentre } from './budgetDriverArgs';
import { driverLabels, driverLineView, hireView } from './budgetDriverView';
import { clampLimit, ok, toolError } from './toolHelpers';

/** Pages sized so the worst realistic reply stays under MAX_READ_RESULT_BYTES (tests/unit/mcp/readLimitsSizeBudgetDrivers.test.ts). */
export const DRIVERS_LIMIT_DEFAULT = 50;
export const DRIVERS_LIMIT_MAX = 75;
export const HIRES_LISTED = 60;
export const OVERRIDES_LISTED = 150;

export const getBudgetDriversTool: McpTool = {
  name: 'get_budget_drivers',
  description:
    'The drivers of one budget version, as the app\'s driver panel shows them: driver lines (paged), planned hires, headcount per month and the override cells (typed over a driver). '
    + 'TRAPS FIRST: a per_head line\'s rate and the headcount counts are shown to owners, admins and managers only (per-person pay, POPIA): any other role gets the line with per_head_restricted true and no amount, and headcount without counts; '
    + 'headcount is payroll actives plus planned hires, at the company or at headcount_cost_centre (a CC1 or CC2, id or code), read now (as_of); a per_head row\'s cells reflect the headcount read on its last write or refresh, not this one. '
    + `Money is decimal text, months YYYY-MM, accounts and members by code. Paged drivers: limit (default ${DRIVERS_LIMIT_DEFAULT}, max ${DRIVERS_LIMIT_MAX}), offset, next_offset; `
    + `at most ${HIRES_LISTED} hires and ${OVERRIDES_LISTED} overrides are listed (their totals say how many there are). Change drivers with set_budget_drivers.`,
  scope: BUDGET_READ_SCOPE,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' },
      headcount_cost_centre: { type: 'string', description: 'A CC1 or CC2 (id or code): headcount at that centre (default: the company).' },
      limit: { type: 'integer', minimum: 1, maximum: DRIVERS_LIMIT_MAX }, offset: { type: 'integer', minimum: 0 },
    },
    required: ['version_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const model = await loadModel(ctx, args.version_id);
    if (isResult(model)) return model;
    const scope = resolveCentre(model, args.headcount_cost_centre, 'headcount_cost_centre');
    if ('reason' in scope) return toolError(scope.reason);
    const versionId = model.version!.id;
    const access = perHeadAccessOf(ctx.companyRole);
    const labels = driverLabels(model);
    const { drivers } = await listDrivers(ctx.companyId, versionId, access);
    const { hires } = await listHires(ctx.companyId, versionId);
    const headcount = await readHeadcount(ctx.companyId, versionId, scope.id, access);
    const limit = clampLimit(args, DRIVERS_LIMIT_DEFAULT, DRIVERS_LIMIT_MAX);
    const offset = Number.isInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : 0;
    const shown = drivers.slice(offset, offset + limit);
    const overrides = model.cells.filter((c) => c.source === 'override');
    return ok({
      version: { id: versionId, name: model.version!.name, fiscal_year: model.version!.fiscalYear, status: model.version!.status },
      version_token: model.updatedAt,
      drivers: shown.map((d) => driverLineView(d, labels)), drivers_total: drivers.length,
      next_offset: offset + shown.length < drivers.length ? offset + shown.length : null,
      planned_hires: hires.slice(0, HIRES_LISTED).map((h) => hireView(h, labels)), planned_hires_total: hires.length,
      headcount: 'months' in headcount
        ? { cost_centre: labels.centre(headcount.costCentreId), months: headcount.months, as_of: headcount.asOf }
        : { cost_centre: labels.centre(headcount.costCentreId), per_head_restricted: true, note: PER_HEAD_RESTRICTED_NOTE },
      overrides: overrides.slice(0, OVERRIDES_LISTED).map((c) => ({ account: labels.account(c.glAccountId), ...labels.grain(c), month: c.month, amount: centsText(toCents(c.amount)) })),
      overrides_total: overrides.length,
    });
  },
};
