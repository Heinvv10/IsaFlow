/**
 * MCP read tool: committed_spend (design docs/design/mcp-po-reports.md, section 5): the open value of the purchase orders that commit
 * spend, summed by supplier / cc2 / account / cc1 / bu / month. It is `budget_remaining`'s committed figure read the other way round:
 * the same lines (`remainingCommitted.readCommitmentLines`), the same per-line open amount (`openPoLineCents`), so for any account,
 * month and budget-level slice the rows add up to budget_remaining's `committed` to the cent. Lines with no account are reported
 * apart (`no_account`): a budget never sees them. Owners, admins and managers only, as budget_remaining; read:reports; free.
 */
import { canWrite } from '@/lib/auth/writeRoles';
import { chartRefResolver, loadChartRefs } from '@/modules/accounting/services/budgets/budgetRefResolve';
import {
  committedSpendReport, DEFAULT_GROUP_BY, GROUP_KEYS, type CommittedGroup, type GroupKey, type Member, type Money,
} from '@/modules/accounting/services/budgets/committedSpend';
import { remainingKeysProblem } from '@/modules/accounting/services/budgets/remainingBudget';
import { UUID_RE } from '@/lib/validation';
import type { McpTool } from '../types';
import { BUDGET_READ_SCOPE, centsText, ID_OR_CODE, refText } from './budgetToolArgs';
import { offsetArg } from './budgetPaging';
import { remainingLimit } from './budgetToolRateLimits';
import { clampLimit, ok, toolError } from './toolHelpers';

/** A page of the widest rows (six members with 60-character names) stays well under MAX_READ_RESULT_BYTES (committedSpendTool.test.ts). */
export const COMMITTED_LIMIT_DEFAULT = 40;
export const COMMITTED_LIMIT_MAX = 60;

const member = (m: Member | null | undefined) => (m == null ? null : { id: m.id, ...(m.code === null ? {} : { code: m.code }), name: m.name });
const moneyView = (m: Money) => ({ committed: centsText(m.cents), po_lines: m.poLines, pos: m.pos });

/** One group as a row: its members under their key names, `committed`, and how many PO lines and POs make it up. */
export function committedRow(g: CommittedGroup) {
  const out: Record<string, unknown> = {};
  for (const k of GROUP_KEYS) if (k in g.members) out[k] = k === 'month' ? g.members.month : member(g.members[k]);
  return { ...out, ...moneyView(g) };
}

export const committedSpendTool: McpTool = {
  name: 'committed_spend',
  description:
    'Committed spend: the open value of purchase orders that commit spend (approved, partially_received, received, and closed by billing while not fully billed) in the order-date months from_month to to_month (YYYY-MM, at most 12 months), '
    + 'ordered less billed per PO line, floored at 0, ex VAT, summed per group. It is the committed figure of budget_remaining read by supplier, cc2, account, cc1, bu or month: for any account, month and budget-level slice the rows add up to budget_remaining\'s committed, to the cent '
    + '(bills net exactly as there: line links, header links, negative lines; a cancelled PO, a short-closed PO and a draft commit nothing). '
    + 'group_by: any of supplier, cc2, account, cc1, bu, month (default supplier, cc2, account; [] gives the total only). Each row carries its members as {id, code, name} (null: the lines have none of it, the unassigned slice), committed as decimal text, po_lines (lines still open) and pos. '
    + 'TRAPS: a PO line with no account cannot meet a budget, so it is never in rows or total: no_account reports it apart (and an account filter leaves it out); a line is grouped under its OWN dimensions, so a line that misses the account\'s budget level is its own row (map it onto the level as budget_remaining does to compare). '
    + 'total is over every group, not only this page; page_committed is this page\'s. Filters: supplier_id, account and cc2 (id or code). '
    + `Paged: limit (default ${COMMITTED_LIMIT_DEFAULT}, max ${COMMITTED_LIMIT_MAX}), offset, next_offset; largest first. Owners, admins and managers only, as budget_remaining. Needs read:reports.`,
  scope: BUDGET_READ_SCOPE,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      from_month: { type: 'string', description: 'First order-date month, YYYY-MM' },
      to_month: { type: 'string', description: 'Last order-date month, YYYY-MM (at most 12 months from from_month)' },
      group_by: { type: 'array', items: { type: 'string', enum: [...GROUP_KEYS] }, uniqueItems: true, description: 'Default supplier, cc2, account; [] for the total only' },
      supplier_id: { type: 'string', format: 'uuid', description: 'Only this supplier\'s POs' },
      account: ID_OR_CODE,
      cc2: ID_OR_CODE,
      limit: { type: 'integer', minimum: 1, maximum: COMMITTED_LIMIT_MAX },
      offset: { type: 'integer', minimum: 0 },
    },
    required: ['from_month', 'to_month'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!canWrite(ctx.companyRole)) return toolError('committed_spend is for owners, admins and managers, as budget_remaining is');
    const { from_month: from, to_month: to } = args;
    if (typeof from !== 'string' || typeof to !== 'string') return toolError('from_month and to_month are required (YYYY-MM)');
    const problem = remainingKeysProblem([from, to]);
    if (problem) return toolError(problem);
    if (from > to) return toolError('from_month must not be after to_month');
    let groupBy: GroupKey[] = [...DEFAULT_GROUP_BY];
    if (args.group_by !== undefined) {
      const g = args.group_by;
      if (!Array.isArray(g) || g.some((k) => !(GROUP_KEYS as readonly unknown[]).includes(k)) || new Set(g).size !== g.length) {
        return toolError(`group_by is a list of ${GROUP_KEYS.join(', ')}, each at most once`);
      }
      groupBy = g as GroupKey[];
    }
    if (args.supplier_id !== undefined && (typeof args.supplier_id !== 'string' || !UUID_RE.test(args.supplier_id))) return toolError('invalid supplier_id');

    // The bucket budget_remaining's previews use (120 a minute a user): both read the same committed engine. After validation, as there.
    const limited = await remainingLimit(ctx);
    if (limited) return limited;
    const named = { account: refText(args.account), cc2: refText(args.cc2, 'cc2') };
    for (const [what, r] of Object.entries(named)) if ('error' in r) return toolError(`${what}: ${r.error}`);
    const wantsRefs = (named.account as { ref: string }).ref !== '' || (named.cc2 as { ref: string }).ref !== '';
    let accountId: string | null = null;
    let cc2Id: string | null = null;
    if (wantsRefs) {
      const refs = chartRefResolver(await loadChartRefs(ctx.companyId));
      const a = (named.account as { ref: string }).ref;
      const c = (named.cc2 as { ref: string }).ref;
      const ra = a === '' ? null : refs.account(a);
      if (ra && !ra.ok) return toolError(ra.reason);
      const rc = c === '' ? null : refs.member('cc2', c);
      if (rc && !rc.ok) return toolError(rc.reason);
      accountId = ra?.item ?? null;
      cc2Id = rc?.item ?? null;
    }

    const limit = clampLimit(args, COMMITTED_LIMIT_DEFAULT, COMMITTED_LIMIT_MAX);
    const report = await committedSpendReport(ctx.companyId, {
      fromMonth: from, toMonth: to, groupBy, supplierId: typeof args.supplier_id === 'string' ? args.supplier_id.toLowerCase() : null, accountId, cc2Id,
    }, { offset: offsetArg(args), limit });
    return ok({
      from_month: from, to_month: to, group_by: groupBy,
      rows: report.groups.map(committedRow),
      groups_total: report.groupsTotal, next_offset: report.nextOffset,
      page_committed: centsText(report.groups.reduce((s, g) => s + g.cents, 0)),
      total: moneyView(report.total), no_account: moneyView(report.noAccount),
    });
  },
};
