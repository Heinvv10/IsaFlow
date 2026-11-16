/**
 * MCP read tools: list_budget_versions and get_budget (budget write tools PR 1). Both read through the
 * services the app's budget pages read (`listVersions`, `loadGridReadModel`), as the token user: a budget
 * holder sees their slices only (a work view, as in the app), and per_head driver rates go to budget
 * writers only (decision 15, #979: `perHeadAccessOf`). Budget figures are report data: read:reports.
 */
import { listVersions } from '@/modules/accounting/services/budgets/budgetVersions';
import { lastEditsOf } from '@/modules/accounting/services/budgets/budgetVersionActivity';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { perHeadAccessOf, isRestrictedPerHead } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import { refResolver } from '@/modules/accounting/services/budgets/budgetRefResolve';
import { BAND_ORDER, type Band } from '@/modules/accounting/services/budgets/grid/subtotals';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import type { McpTool } from '../types';
import { BUDGET_READ_SCOPE, centsText, figuresAllowed, isMonth, isResult, ownVersion, randText, versionView } from './budgetToolArgs';
import { NOT_FOUND, clampLimit, ok, toolError } from './toolHelpers';

export const GET_BUDGET_LIMIT_DEFAULT = 50;
export const GET_BUDGET_LIMIT_MAX = 120;
const MAX_VERSIONS = 200;
const MAX_DRIVERS = 100;

export const listBudgetVersionsTool: McpTool = {
  name: 'list_budget_versions',
  description:
    'The company\'s budget versions, newest year first (primary first within a year), optionally of one fiscal_year (the year\'s label, e.g. 2027): id, year, name, kind (original | reforecast | scenario), status (draft → approved → locked), is_primary (what reports read when no version is named), '
    + 'cells and total (decimal text), version_token (pass it to the write tools), who approved / locked / unlocked it and when, and last_edit (the newest audit row: who, when, what). Read get_budget for the amounts.',
  scope: BUDGET_READ_SCOPE,
  write: false,
  inputSchema: { type: 'object', properties: { fiscal_year: { type: 'integer' } }, additionalProperties: false },
  handler: async (args, ctx) => {
    if (args.fiscal_year !== undefined && !(Number.isInteger(args.fiscal_year) && Number(args.fiscal_year) >= 1900 && Number(args.fiscal_year) <= 2200)) {
      return toolError('fiscal_year must be a year label such as 2027');
    }
    const versions = await listVersions(ctx.companyId, args.fiscal_year as number | undefined);
    const shown = versions.slice(0, MAX_VERSIONS);
    const edits = await lastEditsOf(ctx.companyId, shown.map((v) => v.id));
    const figures = figuresAllowed(ctx);
    return ok({
      items: shown.map((v) => ({ ...versionView(v, figures), last_edit: edits.get(v.id) ?? null })),
      total: versions.length, truncated: versions.length > shown.length,
    });
  },
};

const LEVEL = (c: { cc1Id: string | null; cc2Id: string | null; buId: string | null }) => (c.cc1Id ? 'cc1' : c.cc2Id ? 'cc2' : c.buId ? 'bu' : 'company');

export const getBudgetTool: McpTool = {
  name: 'get_budget',
  description:
    'One budget version\'s amounts as the app\'s budget grid shows them: version_id, or fiscal_year for that year\'s primary (else newest) version; version null when the year has none. '
    + 'TRAPS FIRST: rows are (account, level, member) with one decimal-text amount per month; an account is budgeted at ONE level per version (company, or cc1, cc2 or bu members); a header account is never a row (its sub-accounts are); '
    + 'totals are the WHOLE version per section and GP/OP/NP per month (not the filtered rows); a budget holder sees only their own slices; source tells typed / driver / override / actual (a reforecast\'s closed months) when not all typed. '
    + `Filters: accounts (ids or codes), section, level, member, from_month/to_month (YYYY-MM). Paged: limit (default ${GET_BUDGET_LIMIT_DEFAULT}, max ${GET_BUDGET_LIMIT_MAX}), offset, next_offset. `
    + 'version_token is what the write tools need. include_drivers lists the version\'s driver lines (per-head rates only for owners, admins and managers).',
  scope: BUDGET_READ_SCOPE,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' }, fiscal_year: { type: 'integer' },
      accounts: { type: 'array', items: { type: 'string' }, maxItems: 500, description: 'Account ids or codes.' },
      section: { type: 'string', enum: [...BAND_ORDER] },
      level: { type: 'string', enum: ['company', 'cc1', 'cc2', 'bu'] },
      member: { type: 'string', description: 'A cc1 / cc2 / bu member id or code (with level).' },
      from_month: { type: 'string' }, to_month: { type: 'string' },
      include_drivers: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: GET_BUDGET_LIMIT_MAX }, offset: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    let versionId: string | undefined;
    if (args.version_id !== undefined) {
      const v = await ownVersion(ctx, args.version_id);
      if (isResult(v)) return v;
      versionId = v.id;
    } else if (!(Number.isInteger(args.fiscal_year) && Number(args.fiscal_year) >= 1900 && Number(args.fiscal_year) <= 2200)) {
      return toolError('Pass version_id, or fiscal_year as a year label such as 2027');
    }
    for (const k of ['from_month', 'to_month'] as const) if (args[k] !== undefined && !isMonth(args[k])) return toolError(`${k} must be YYYY-MM`);
    if (args.section !== undefined && !(BAND_ORDER as readonly unknown[]).includes(args.section)) return toolError(`section must be one of ${BAND_ORDER.join(', ')}`);
    if (args.member !== undefined && (args.level === undefined || args.level === 'company')) return toolError('member needs level cc1, cc2 or bu');
    let model;
    try {
      model = await loadGridReadModel(ctx.companyId, versionId ? { versionId } : { fiscalYear: Number(args.fiscal_year) }, perHeadAccessOf(ctx.companyRole), ctx.userId);
    } catch (err) {
      if (err instanceof FiscalYearLabelUnknownError) return toolError(NOT_FOUND);
      throw err;
    }
    const figures = figuresAllowed(ctx);
    const resolver = refResolver(model);
    let accountFilter: Set<string> | null = null;
    if (Array.isArray(args.accounts)) {
      accountFilter = new Set();
      for (const ref of args.accounts) {
        const found = typeof ref === 'string' ? resolver.account(ref.trim()) : null;
        if (!found) return toolError(`accounts: ${JSON.stringify(String(ref).slice(0, 40))} is not an account this budget lists`);
        if (!found.ok) return toolError(`accounts: ${found.reason}`);
        accountFilter.add(found.item.id);
      }
    }
    let memberId: string | null = null;
    if (typeof args.member === 'string') {
      const m = resolver.member(args.level as 'cc1', args.member.trim());
      if (!m.ok) return toolError(m.reason);
      memberId = m.item.id;
    }
    const months = model.year.monthKeys.filter((m) => (!args.from_month || m >= String(args.from_month)) && (!args.to_month || m <= String(args.to_month)));
    const inWindow = new Set(months);
    const accounts = new Map(model.accounts.map((a) => [a.id, a]));
    const rows = new Map<string, { account: string; account_name: string; account_id: string; section: Band; level: string; member: string | null; cents: Map<string, number>; sources: Set<string> }>();
    const memberCode = (kind: string, id: string | null) => (id === null ? null : model.dimensions[kind as 'cc1'].find((m) => m.id === id)?.code ?? id);
    for (const c of model.cells) {
      const a = accounts.get(c.glAccountId);
      if (!a || !inWindow.has(c.month)) continue;
      const level = LEVEL(c);
      const member = c.cc1Id ?? c.cc2Id ?? c.buId;
      if ((accountFilter && !accountFilter.has(a.id)) || (args.section && a.band !== args.section) || (args.level && level !== args.level) || (memberId && member !== memberId)) continue;
      const key = `${a.id}|${level}|${member ?? ''}`;
      const row = rows.get(key) ?? { account: a.code, account_name: a.name, account_id: a.id, section: a.band, level, member: memberCode(level, member), cents: new Map(), sources: new Set() };
      row.cents.set(c.month, toCents(c.amount));
      row.sources.add(c.source);
      rows.set(key, row);
    }
    const all = [...rows.values()];
    const limit = clampLimit(args, GET_BUDGET_LIMIT_DEFAULT, GET_BUDGET_LIMIT_MAX);
    const offset = Number.isInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : 0;
    const page = all.slice(offset, offset + limit).map(({ cents, sources, ...r }) => ({
      ...r, ...(sources.size === 1 && sources.has('typed') ? {} : { source: [...sources].sort() }),
      ...(figures ? { months: Object.fromEntries([...cents].map(([m, v]) => [m, centsText(v)])), total: centsText([...cents.values()].reduce((s, v) => s + v, 0)) } : {}),
      ...(accounts.get(r.account_id)?.note ? { note: accounts.get(r.account_id)!.note } : {}),
    }));
    const drivers = args.include_drivers === true ? model.drivers.slice(0, MAX_DRIVERS).map((d) => ({
      account: accounts.get(d.glAccountId)?.code ?? d.glAccountId, level: LEVEL(d), kind: d.kind, from_month: d.fromMonth, to_month: d.toMonth, pct: d.pct,
      ...(isRestrictedPerHead(d) ? { per_head_restricted: true } : figures && 'amount' in d && d.amount !== null ? { amount: randText(d.amount) } : {}),
    })) : undefined;
    return ok({
      version: model.version ? versionView(model.version, figures) : null, version_token: model.updatedAt, fiscal_year: model.year.fiscalYear,
      year_months: model.year.monthKeys, months,
      rows: page, rows_total: all.length, next_offset: offset + page.length < all.length ? offset + page.length : null,
      ...(figures ? { totals: Object.fromEntries(Object.entries(model.totals.months).map(([k, v]) => [k, { year: randText(model.totals.fy[k as 'turnover']), months: v.map(randText) }])) } : {}),
      holder: model.holder ? { slices: model.holder.slices.length } : null,
      ...(drivers ? { drivers, drivers_total: model.drivers.length } : {}),
    });
  },
};

export const BUDGET_READ_TOOLS: McpTool[] = [listBudgetVersionsTool, getBudgetTool];
