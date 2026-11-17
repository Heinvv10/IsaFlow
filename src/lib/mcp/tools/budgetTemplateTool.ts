/**
 * MCP read tool get_budget_template (budget tools PR 2): the app's budget template for one version
 * (`budgetTemplateXlsx`, the services the template route calls, as the token user: a budget holder's template
 * carries only their slices). Two forms of the same grid:
 *  - json (default, paged): rows of account / dimension with one decimal-text amount per month (null = not
 *    budgeted), the FY total and PY actual the workbook shows, each row's signed `base` (its months as read:
 *    the JSON grid's `_base`, review round 1), and the version's section totals. Edit `months` and send the rows
 *    back to import_budget_workbook, from any pages, in one call or several.
 *  - xlsx: the very workbook the template route downloads, as base64 with its file name and `_meta` signature,
 *    for Excel-driven flows; refused (with the way out) when it would not fit one reply (MAX_READ_RESULT_BYTES).
 *    The build takes the template route's CPU slot (a short MCP wait) and its own mcp- rate bucket; json has its own.
 */
import { checkRateLimit } from '@/lib/rateLimit';
import { BUDGET_SPREADSHEET_SLOT, CpuSlotBusyError } from '@/lib/withCpuSlot';
import { UUID_RE } from '@/lib/validation';
import {
  loadBudgetTemplate, loadTemplateInputs, templateGrid, TEMPLATE_GRAINS, type TemplateGrain, type TemplateGrid,
} from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { McpTool, McpToolContext, McpToolResult } from '../types';
import { BUDGET_READ_SCOPE, centsText, isResult, MCP_SLOT_WAIT_MS, ownVersion, randText, spreadsheetBusy } from './budgetToolArgs';
import { encodeRowBase } from '@/modules/accounting/services/budgets/budgetTemplateSignature';
import { NOT_FOUND, clampLimit, ok, toolError } from './toolHelpers';

/** JSON rows a page: the widest row (14 months of the widest amount, long names and codes, its signed base) is ~1.35 KB; 50 make ~72 KB (readLimitsSizeBudgets). */
export const TEMPLATE_LIMIT_DEFAULT = 40;
export const TEMPLATE_LIMIT_MAX = 50;
/** The largest base64 workbook one reply carries, leaving room for the rest of it under MAX_READ_RESULT_BYTES. */
export const XLSX_MAX_BASE64 = 85_000;
const MAX_MEMBERS = 500;
/** Each format its own mcp- bucket (never the app's, so an agent cannot lock its person out of the grid): JSON pages are many. */
const RATE = { xlsx: { max: 60, windowSecs: 900 }, json: { max: 600, windowSecs: 900 } } as const;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const totalsView = (model: GridReadModel) => Object.fromEntries(Object.entries(model.totals.months)
  .map(([k, v]) => [k, { year: randText(model.totals.fy[k as keyof typeof model.totals.fy]), months: v.map(randText) }]));

/** The template's rows as the JSON grid import_budget_workbook takes back, each with its signed base (its months as read). */
function jsonRows(grid: TemplateGrid) {
  const meta = { versionId: grid.meta.versionId, fiscalYear: grid.meta.fiscalYear, grain: grid.meta.grain, months: grid.months };
  return grid.rows.map((r) => {
    const cents = grid.months.map((m) => grid.values.get(`${r.rowKey}|${m}`) ?? null);
    const py = grid.py.get(r.rowKey);
    return {
      section: r.account.band, account: r.account.code, account_name: r.account.name, account_id: r.account.id,
      ...(r.member ? { dimension: r.member.code, dimension_name: r.member.name, dimension_id: r.member.id } : {}),
      months: Object.fromEntries(grid.months.map((m, i) => [m, cents[i] === null ? null : centsText(cents[i]!)])),
      fy_total: centsText(cents.reduce<number>((s, c) => s + (c ?? 0), 0)), py_actual: py === undefined ? null : centsText(py),
      base: encodeRowBase(meta, { accountId: r.account.id, memberId: r.member?.id ?? null, cents }),
    };
  });
}

function membersArg(raw: unknown): string[] | undefined | McpToolResult {
  if (raw === undefined) return undefined;
  const bad = toolError(`members must be member ids (from list_cost_centres / list_business_units), 1 to ${MAX_MEMBERS} of them`);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MEMBERS) return bad;
  // Ids compare lower-case everywhere (Postgres answers them so), as the template route reads them.
  return raw.every((m) => typeof m === 'string' && UUID_RE.test(m)) ? raw.map((m) => (m as string).toLowerCase()) : bad;
}

async function xlsxReply(ctx: McpToolContext, versionId: string, grain: TemplateGrain, members: string[] | undefined): Promise<McpToolResult> {
  // The route's order: the slot, then the bucket, then the read and the build.
  const t = await BUDGET_SPREADSHEET_SLOT.run(async () => {
    if (!(await checkRateLimit(`mcp-budget-template-xlsx:${ctx.userId}`, RATE.xlsx))) return null;
    return loadBudgetTemplate(ctx.companyId, versionId, grain, members, ctx.userId);
  }, ctx.userId, MCP_SLOT_WAIT_MS);
  if (t === null) return toolError('Too many template downloads — wait a few minutes and try again.');
  const fileBase64 = t.file.toString('base64');
  if (fileBase64.length > XLSX_MAX_BASE64) {
    return toolError(`The .xlsx template is ${Math.round(fileBase64.length / 1000)} KB as base64, over the ${Math.round(XLSX_MAX_BASE64 / 1000)} KB one reply can carry. `
      + 'Read it as format json (paged; import_budget_workbook takes those rows back), or name fewer members at a cc1, cc2 or bu grain.');
  }
  return ok({
    format: 'xlsx', version_id: versionId, version_token: t.meta.updatedAt, fiscal_year: t.meta.fiscalYear, grain, rows: t.rows,
    file_name: t.fileName, mime_type: XLSX_MIME, bytes: t.file.length, signature: t.meta.signature, file_base64: fileBase64,
    next_step: 'Decode file_base64 to the .xlsx, edit the month columns in the Budget sheet (leave _meta and _base alone), and send it back base64 to import_budget_workbook with dry_run true.',
  });
}

export const getBudgetTemplateTool: McpTool = {
  name: 'get_budget_template',
  description:
    'The budget template of one budget version, the grid the app\'s Excel download holds, to edit and send back to import_budget_workbook. '
    + 'WORKFLOW: list_budget_versions (pick the version) → get_budget_template → edit the amounts → import_budget_workbook dry_run true (the diff, totals and plan_hash) → import_budget_workbook dry_run false with that plan_hash → get_budget / budget_variance to check; restore_budget_version undoes the import. '
    + 'format json (default): rows of section, account (code, name, id), at a cc1/cc2/bu grain the dimension (code, name, id), months (one decimal-text amount per YYYY-MM month of the year; null = NOT budgeted, "0.00" = budgeted at zero), fy_total and py_actual (prior-year actual, for reference; both ignored on import), and base (the row\'s months as read, signed: send it back UNCHANGED; it is what the import compares your months with, so a colleague\'s save after your read is never reverted), '
    + `plus version_token and the version's section totals per month (for a budget holder, their slices). Paged: limit (default ${TEMPLATE_LIMIT_DEFAULT}, max ${TEMPLATE_LIMIT_MAX}), offset, rows_total, next_offset; send the rows you changed, from any pages, in one import call or several. `
    + `format xlsx: the same workbook the app downloads, as file_base64 with file_name and signature, for an agent that can open Excel files (most chat agents cannot: use json); refused when its base64 is over ${Math.round(XLSX_MAX_BASE64 / 1000)} KB (a few hundred rows): use json, or fewer members. `
    + 'TRAPS: an account is budgeted at ONE level per version, so a cc1/cc2/bu template offers only accounts budgeted at that level or not at all (decision 4); at a dimension grain the rows are the named members (members: ids), else the members holding amounts or prior-year activity; header accounts appear only when they hold their own amounts. Needs read:reports.',
  scope: BUDGET_READ_SCOPE,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' },
      format: { type: 'string', enum: ['json', 'xlsx'], description: 'json (default, paged) or xlsx (base64).' },
      grain: { type: 'string', enum: [...TEMPLATE_GRAINS], description: 'company (default), cc1, cc2 or bu.' },
      members: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: MAX_MEMBERS, description: 'cc1 / cc2 / bu grain: the member ids to offer as rows.' },
      limit: { type: 'integer', minimum: 1, maximum: TEMPLATE_LIMIT_MAX }, offset: { type: 'integer', minimum: 0 },
    },
    required: ['version_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const format = args.format ?? 'json';
    if (format !== 'json' && format !== 'xlsx') return toolError('format must be json or xlsx');
    const grain = (args.grain ?? 'company') as TemplateGrain;
    if (!TEMPLATE_GRAINS.includes(grain)) return toolError(`grain must be one of ${TEMPLATE_GRAINS.join(', ')}`);
    const members = membersArg(args.members);
    if (isResult(members)) return members;
    const version = await ownVersion(ctx, args.version_id);
    if (isResult(version)) return version;
    try {
      if (format === 'xlsx') return await xlsxReply(ctx, version.id, grain, members);
      if (!(await checkRateLimit(`mcp-budget-template-json:${ctx.userId}`, RATE.json))) return toolError('Too many template reads — wait a few minutes and try again.');
      const { model, prior } = await loadTemplateInputs(ctx.companyId, version.id, grain, ctx.userId);
      const grid = templateGrid(model, grain, prior, members);
      const all = jsonRows(grid);
      const limit = clampLimit(args, TEMPLATE_LIMIT_DEFAULT, TEMPLATE_LIMIT_MAX);
      const offset = Number.isInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : 0;
      const rows = all.slice(offset, offset + limit);
      const next = offset + rows.length;
      return ok({
        format: 'json', version: { id: version.id, name: version.name, fiscal_year: version.fiscalYear, status: version.status },
        version_token: grid.meta.updatedAt, grain, months: grid.months, rows, rows_total: all.length, next_offset: next < all.length ? next : null,
        totals: totalsView(model),
        next_step: 'Edit months (decimal strings; null = not budgeted) and send the rows, unchanged otherwise, with this version_token to import_budget_workbook (dry_run true first). Rows you leave out are untouched.',
      });
    } catch (err) {
      if (err instanceof CpuSlotBusyError) return spreadsheetBusy(err);
      if (err instanceof FiscalYearLabelUnknownError) return toolError(NOT_FOUND);
      if (err instanceof BudgetVersionError) return toolError(err.code === 'BUDGET_VERSION_NOT_FOUND' ? NOT_FOUND : err.message);
      throw err;
    }
  },
};
