/**
 * MCP budget control reads (budget tools PR 3), over the services the app's budget controls call:
 *  - budget_remaining: `remainingFor` (POST /api/accounting/budgets/remaining, the approve dialog's and PO form's
 *    preview): budget writers only as that route (withWriteAccess), its bounds (`remainingKeysProblem`), accounts
 *    and members by id or code per row (PR 1's resolver over the grid of the month's year: a bad row is refused in
 *    place, the rest answered);
 *  - budget_tracking: the overspend alerts the controls page lists (`listBudgetAlerts`, GET /budgets/alerts): owners
 *    and admins only, fenced by the registry as that route is (requiresRole 'admin').
 * Figures as decimal text. read:reports.
 */
import { canWrite } from '@/lib/auth/writeRoles';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { remainingFor, remainingKeysProblem, MAX_REMAINING_KEYS, type RemainingKey } from '@/modules/accounting/services/budgets/remainingBudget';
import { mapRegistryMiss, registryYears } from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { ALERT_LIST_LIMIT, listBudgetAlerts, type BudgetAlertItem } from '@/modules/accounting/services/budgets/budgetAlertList';
import type { McpTool } from '../types';
import { BUDGET_READ_SCOPE, randText } from './budgetToolArgs';
import { dimensionLabel, resolveRows, type RowRef } from './budgetCellArgs';
import { driverLabels } from './budgetDriverView';
import { clampLimit, ok, toolError } from './toolHelpers';

const ID_OR_CODE = { type: 'string', description: 'Id or code.' };
const money = (v: number | null) => (v === null ? null : randText(v));

export const budgetRemainingTool: McpTool = {
  name: 'budget_remaining',
  description:
    'Remaining budget per account, slice and month, as the app\'s approve dialog and purchase-order form preview it: budget (the PRIMARY version of the month\'s year, at the account\'s level), posted actual, committed (open purchase-order lines less what their bills posted) and remaining = budget - actual - committed. '
    + 'TRAPS FIRST: budget null means "No budget" (no primary version, the account holds no budget there, or the line misses the level\'s dimension: unassigned), never 0 (a budgeted zero is 0); off_slice true means the account is budgeted but not on this slice (an approval warns or refuses it); '
    + 'a line names at most one dimension (cc1, cc2 or bu, by id or code); its dimensions map onto the account\'s level (keep that level\'s, drop the rest). '
    + `At most ${MAX_REMAINING_KEYS} lines whose months (YYYY-MM) span at most 12 months; a line that cannot be read is refused in place with its reason. Owners, admins and managers only, as in the app. Figures are decimal text. Needs read:reports.`,
  scope: BUDGET_READ_SCOPE,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array', minItems: 1, maxItems: MAX_REMAINING_KEYS,
        items: {
          type: 'object', properties: { account: ID_OR_CODE, month: { type: 'string', description: 'YYYY-MM' }, cc1: ID_OR_CODE, cc2: ID_OR_CODE, bu: ID_OR_CODE },
          required: ['account', 'month'], additionalProperties: false,
        },
      },
    },
    required: ['lines'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!canWrite(ctx.companyRole)) return toolError('budget_remaining is for owners, admins and managers, as the app\'s remaining-budget preview is');
    if (!Array.isArray(args.lines) || args.lines.length === 0) return toolError('lines must list at least one line');
    const rows = args.lines.map((l, index) => {
      const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
      return { index, account: o.account, cc1: o.cc1, cc2: o.cc2, bu: o.bu, month: typeof o.month === 'string' ? o.month : '' };
    });
    const problem = remainingKeysProblem(rows.map((r) => r.month));
    if (problem) return toolError(problem);
    // Each row resolves against the grid of its month's financial year (the year whose primary version answers it).
    const years = registryYears(ctx.companyId);
    const labelOf = new Map<string, number | { reason: string }>();
    for (const month of new Set(rows.map((r) => r.month))) {
      try {
        labelOf.set(month, (await years.forDate(`${month}-01`))!.fiscalYear);
      } catch (err) {
        if (!(err instanceof TrackingError)) throw err;
        labelOf.set(month, { reason: err.message });
      }
    }
    const refused = new Map<number, string>();
    const keyed: Array<{ row: (typeof rows)[number]; key: RemainingKey }> = [];
    const models = new Map<number, GridReadModel>();
    for (const label of new Set([...labelOf.values()].filter((v): v is number => typeof v === 'number'))) {
      const model = await loadGridReadModel(ctx.companyId, { fiscalYear: label }, 'totals');
      models.set(label, model);
      const mine = rows.filter((r) => labelOf.get(r.month) === label);
      const refs = await resolveRows(ctx, model, mine as RowRef[]);
      for (const r of mine) {
        const ref = refs.get(r.index);
        if (!ref || !('glAccountId' in ref)) refused.set(r.index, ref?.reason ?? 'unresolved');
        else keyed.push({ row: r, key: { ...ref, month: r.month } });
      }
    }
    for (const r of rows) {
      const label = labelOf.get(r.month);
      if (typeof label === 'object' && label !== undefined) refused.set(r.index, label.reason);
    }
    const results = keyed.length === 0 ? [] : await mapRegistryMiss(() => remainingFor(ctx.companyId, keyed.map((k) => k.key)));
    const answered = new Map(keyed.map((k, i) => [k.row.index, results[i]!]));
    const lines = rows.map((r) => {
      const head = { i: r.index, account: String(r.account ?? '').slice(0, 64), dimension: dimensionLabel(r), month: r.month };
      const res = answered.get(r.index);
      if (!res) return { ...head, refused: refused.get(r.index) ?? 'unresolved' };
      const labels = driverLabels(models.get(labelOf.get(r.month) as number)!);
      const slice = labels.grain(res.slice);
      return {
        ...head, version_id: res.versionId, grain: res.grain,
        slice: { cc1: res.slice.cc1Id ? slice.member : null, cc2: res.slice.cc2Id ? slice.member : null, bu: res.slice.buId ? slice.member : null },
        unassigned: res.unassigned, off_slice: res.offSlice,
        budget: money(res.budget), actual: money(res.actual), committed: money(res.committed), remaining: money(res.remaining),
      };
    });
    return ok({ lines, answered: keyed.length, refused: refused.size });
  },
};

export const ALERTS_LIMIT_DEFAULT = 50;
export const ALERTS_LIMIT_MAX = 100;

const alertView = (a: BudgetAlertItem) => ({
  id: a.id, version_id: a.versionId, account: a.accountCode, account_name: a.accountName, slice: a.sliceName, month: a.month,
  threshold: a.threshold, budget: randText(a.budget), actual: randText(a.actual), committed: randText(a.committed), pct: a.pct,
  fired_at: a.firedAt, resolved_at: a.resolvedAt,
});

export const budgetTrackingTool: McpTool = {
  name: 'budget_tracking',
  description:
    'The company\'s budget overspend alerts, as the app\'s Budget controls page lists them: status open (still over a threshold) or resolved (in the last 30 days). Each: account, slice, month, the threshold crossed (% of budget), budget, actual, committed and pct = (actual + committed) / budget. '
    + 'TRAPS FIRST: alerts are recorded when the alerts are evaluated (daily, or Evaluate now in the app), not live: last_evaluated says when; they cover the PRIMARY version of the current financial year, expense accounts only; '
    + `pct null is spend against a zero budget; an open alert of an earlier year stays open (that year ended over budget). The app lists at most ${ALERT_LIST_LIMIT} per status (capped true). For live figures use budget_remaining; for Budget vs Actual use budget_variance. `
    + `Paged: status, limit (default ${ALERTS_LIMIT_DEFAULT}, max ${ALERTS_LIMIT_MAX}), offset, next_offset. Owners and admins only, as in the app. Needs read:reports.`,
  scope: BUDGET_READ_SCOPE,
  write: false,
  requiresRole: 'admin',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['open', 'resolved'] },
      limit: { type: 'integer', minimum: 1, maximum: ALERTS_LIMIT_MAX }, offset: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const status = args.status ?? 'open';
    if (status !== 'open' && status !== 'resolved') return toolError('status must be open or resolved');
    const list = await listBudgetAlerts(ctx.companyId);
    const all = status === 'open' ? list.open : list.resolved;
    const limit = clampLimit(args, ALERTS_LIMIT_DEFAULT, ALERTS_LIMIT_MAX);
    const offset = Number.isInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : 0;
    const items = all.slice(offset, offset + limit);
    const next = offset + items.length;
    return ok({
      status, items: items.map(alertView), total: all.length, next_offset: next < all.length ? next : null,
      open_total: list.open.length, resolved_total: list.resolved.length, capped: all.length >= ALERT_LIST_LIMIT, last_evaluated: list.lastEvaluated,
    });
  },
};
