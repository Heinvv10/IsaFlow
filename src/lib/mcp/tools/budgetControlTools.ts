/**
 * MCP budget control reads (budget tools PR 3), over the services the app's budget controls call:
 *  - budget_remaining: `remainingFor` (POST /api/accounting/budgets/remaining, the approve dialog's and PO form's
 *    preview): budget writers only as that route (withWriteAccess), its bounds (`remainingKeysProblem`), its lines
 *    as it takes them (any account of the company, any of cc1 / cc2 / bu: the service maps them onto the account's
 *    level), by id or code (`chartRefResolver`; an unknown reference refused in place, the rest answered), a
 *    TrackingError answered with its message as the route's `respondTrackingError`;
 *  - budget_tracking: the overspend alerts the controls page lists (`listBudgetAlerts`, GET /budgets/alerts): owners
 *    and admins only, fenced by the registry as that route is (requiresRole 'admin').
 * Holder slices are a work scope, not a confidentiality boundary (as in the app): neither read is narrowed to a
 * holder's slices. Figures as decimal text. read:reports.
 */
import { canWrite } from '@/lib/auth/writeRoles';
import { chartRefResolver, loadChartRefs } from '@/modules/accounting/services/budgets/budgetRefResolve';
import { remainingFor, remainingKeysProblem, MAX_REMAINING_KEYS, type RemainingKey } from '@/modules/accounting/services/budgets/remainingBudget';
import { mapRegistryMiss } from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { ALERT_LIST_LIMIT, listBudgetAlerts, type BudgetAlertItem } from '@/modules/accounting/services/budgets/budgetAlertList';
import type { McpTool } from '../types';
import { BUDGET_READ_SCOPE, DIM_REF, ID_OR_CODE, randText, refText } from './budgetToolArgs';
import { offsetArg } from './budgetPaging';
import { remainingLimit } from './budgetToolRateLimits';
import { clampLimit, ok, toolError } from './toolHelpers';

const DIMS = ['cc1', 'cc2', 'bu'] as const;
const money = (v: number | null) => (v === null ? null : randText(v));

export const budgetRemainingTool: McpTool = {
  name: 'budget_remaining',
  description:
    'Remaining budget per account, slice and month, as the app\'s approve dialog and purchase-order form preview it: budget (the PRIMARY version of the month\'s year, at the account\'s level), posted actual, committed (open purchase-order lines less what their bills posted) and remaining = budget - actual - committed. '
    + 'TRAPS FIRST: budget null means "No budget" (no primary version, the account holds no budget there, or the line misses the level\'s dimension: unassigned), never 0 (a budgeted zero is 0); off_slice true means the account is budgeted but not on this slice (an approval warns or refuses it); '
    + 'a line names an account (any account of the company: a balance-sheet one answers with no budget) and any of cc1, cc2 and bu, as a document line carries them: they map onto the account\'s level (that level\'s dimension kept, the rest dropped), and slice says what it mapped to. '
    + 'A budget holder sees every line, not only their slices: slices are a work scope, not a confidentiality boundary, as in the app. '
    + `At most ${MAX_REMAINING_KEYS} lines whose months (YYYY-MM) span at most 12 months; an account or member that is not the company's is refused in place. Owners, admins and managers only, as in the app. Figures are decimal text. Needs read:reports.`,
  scope: BUDGET_READ_SCOPE,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array', minItems: 1, maxItems: MAX_REMAINING_KEYS,
        items: {
          type: 'object', properties: { account: ID_OR_CODE, month: { type: 'string', description: 'YYYY-MM' }, cc1: DIM_REF, cc2: DIM_REF, bu: DIM_REF },
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
      return { index, account: refText(o.account), shown: typeof o.account === 'number' ? String(o.account) : typeof o.account === 'string' ? o.account.trim() : '', month: typeof o.month === 'string' ? o.month : '', dims: Object.fromEntries(DIMS.map((d) => [d, o[d]])) };
    });
    const problem = remainingKeysProblem(rows.map((r) => r.month));
    if (problem) return toolError(problem);
    const limited = await remainingLimit(ctx);
    if (limited) return limited;
    const chart = await loadChartRefs(ctx.companyId);
    const refs = chartRefResolver(chart);
    const keyed: Array<{ index: number; key: RemainingKey }> = [];
    const refused = new Map<number, string>();
    for (const r of rows) {
      if ('error' in r.account) { refused.set(r.index, r.account.error); continue; }
      if (r.account.ref === '') { refused.set(r.index, 'account is required (an id or code)'); continue; }
      const account = refs.account(r.account.ref);
      if (!account.ok) { refused.set(r.index, account.reason); continue; }
      const ids: Record<(typeof DIMS)[number], string | null> = { cc1: null, cc2: null, bu: null };
      const bad = DIMS.flatMap((d) => {
        if (r.dims[d] === undefined || r.dims[d] === null) return [];
        const read = refText(r.dims[d], d);
        if ('error' in read) return [read.error];
        const m = refs.member(d, read.ref);
        if (!m.ok) return [m.reason];
        ids[d] = m.item;
        return [];
      });
      if (bad.length > 0) { refused.set(r.index, bad.join('; ')); continue; }
      keyed.push({ index: r.index, key: { glAccountId: account.item, cc1Id: ids.cc1, cc2Id: ids.cc2, buId: ids.bu, month: r.month } });
    }
    let results;
    try {
      results = keyed.length === 0 ? [] : await mapRegistryMiss(() => remainingFor(ctx.companyId, keyed.map((k) => k.key)));
    } catch (err) {
      // The route answers a TrackingError with its message (respondTrackingError); nothing was written.
      if (err instanceof TrackingError) return toolError(err.message);
      throw err;
    }
    const answered = new Map(keyed.map((k, i) => [k.index, results[i]!]));
    const code = new Map([...chart.accounts, ...chart.members].map((x) => [x.id, x.code]));
    const lines = rows.map((r) => {
      const head = { i: r.index, account: r.shown.slice(0, 64), month: r.month };
      const res = answered.get(r.index);
      if (!res) return { ...head, refused: refused.get(r.index) ?? 'unresolved' };
      const member = (id: string | null) => (id === null ? null : code.get(id) ?? id);
      return {
        ...head, version_id: res.versionId, grain: res.grain,
        slice: { cc1: member(res.slice.cc1Id), cc2: member(res.slice.cc2Id), bu: member(res.slice.buId) },
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
    'Overspend alerts only; for budget vs actual use budget_variance. The company\'s budget overspend alerts, as the app\'s Budget controls page lists them: status open (still over a threshold) or resolved (in the last 30 days). Each: account, slice, month, the threshold crossed (% of budget), budget, actual, committed and pct = (actual + committed) / budget. '
    + 'TRAPS: alerts are recorded when the alerts are evaluated (daily, or Evaluate now in the app), not live: last_evaluated says when; they cover the PRIMARY version of the current financial year, expense accounts only; '
    + `pct null is spend against a zero budget; an open alert of an earlier year stays open (that year ended over budget). The app lists at most ${ALERT_LIST_LIMIT} per status (capped true). For live figures use budget_remaining. `
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
    const offset = offsetArg(args);
    const items = all.slice(offset, offset + limit);
    const next = offset + items.length;
    return ok({
      status, items: items.map(alertView), total: all.length, next_offset: next < all.length ? next : null,
      open_total: list.open.length, resolved_total: list.resolved.length, capped: all.length >= ALERT_LIST_LIMIT, last_evaluated: list.lastEvaluated,
    });
  },
};
