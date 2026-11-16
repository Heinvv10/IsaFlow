/**
 * MCP write tool import_budget_workbook (budget tools PR 2): the app's Excel import for an agent. The input is
 * the template as an .xlsx (base64, read and checked exactly as the import preview route reads it: the
 * spreadsheet limits, `_meta`, the signed `_base`, the month headers) or as get_budget_template's JSON grid
 * (`budgetWorkbookGrid`); both become the import's own lines and go through the SAME resolve and 3-way diff
 * (`budgetImportDiff.diffImportLines`) and the preview's holder-slice check. The changed cells then go through
 * PR 1's one write path (`budgetAmountWrite.runAmountWrite`, mode merge): the dry run runs the real grid save
 * rolled back and answers the diff, totals and plan_hash; the live call is all or nothing, needs the plan_hash
 * for more than one cell, is refused past MAX_SAVE_CELLS (never chunked), records the undo snapshot that
 * restore_budget_version reads, and the grid save writes its own audit row as the token user. The app's commit
 * sends the preview's cells to the save route in the same shape and order, so both leave the same rows.
 */
import { checkRateLimit } from '@/lib/rateLimit';
import { BUDGET_SPREADSHEET_SLOT, CpuSlotBusyError } from '@/lib/withCpuSlot';
import { SpreadsheetRefusedError } from '@/lib/xlsxToCsv';
import { readBudgetWorkbook } from '@/modules/accounting/services/budgets/budgetImportParse';
import { assertHolderSlices, diffImportLines, workbookSource, type ImportSource } from '@/modules/accounting/services/budgets/budgetImportDiff';
import { COLUMN, TEMPLATE_GRAINS, type TemplateGrain } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import { codeIndex } from '@/modules/accounting/services/budgets/codeIndex';
import { explainMissingAccounts } from '@/modules/accounting/services/budgets/budgetRefResolve';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { cellKey, parseKey, rowKeyOf } from '@/modules/accounting/services/budgets/grid/cellKey';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import { MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSave';
import type { PlanInput } from '@/modules/accounting/services/budgets/cellWritePlan';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import type { McpTool } from '../types';
import { BUDGET_WRITE_FENCE, isMonth, isResult, planHashArg, randText, versionTokenArg } from './budgetToolArgs';
import { DIFF_LIST_DEFAULT, DIFF_LIST_MAX, type RowRefusal } from './budgetDiffView';
import { loadModel, runAmountWrite } from './budgetAmountWrite';
import { page } from './budgetAmountTools';
import { GRID_ROW_KEYS, gridLines, MAX_GRID_ROWS } from './budgetWorkbookGrid';
import { NOT_FOUND, toolError } from './toolHelpers';

export { MAX_GRID_ROWS };

/** base64 characters one call takes: about 2.1 MB of .xlsx, under the MCP endpoint's 3 MB body (pages/api/mcp/index.ts). */
export const MAX_WORKBOOK_BASE64 = 2_900_000;
const IMPORT_RATE = 60;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const WARNINGS_LISTED = 20;
const CONFLICTS_LISTED = 50;

/** The file's own conflicts (changed in the file AND in the version since the download), named by code. */
function conflictView(model: GridReadModel, conflicts: ReadonlyArray<{ key: string; downloaded: number | null; current: number | null; after: number | null }>) {
  const codes = new Map(model.accounts.map((a) => [a.id, a.code]));
  const money = (v: number | null) => (v === null ? null : randText(v));
  return conflicts.slice(0, CONFLICTS_LISTED).map((c) => {
    const ref = parseKey(c.key);
    return { account: codes.get(ref.glAccountId) ?? ref.glAccountId, month: ref.month, downloaded: money(c.downloaded), current: money(c.current), after: money(c.after) };
  });
}

export const importBudgetWorkbookTool: McpTool = {
  name: 'import_budget_workbook',
  description:
    'Import an edited budget template into its budget version: the app\'s Excel import, for an agent. '
    + 'WORKFLOW: list_budget_versions → get_budget_template → edit → import_budget_workbook dry_run true (the cells it changes, section totals before and after, warnings, conflicts, plan_hash) → the same call with dry_run false and that plan_hash → get_budget / budget_variance to check; restore_budget_version undoes the import while nobody has changed the version since. '
    + `Send ONE of: rows, get_budget_template's JSON rows (account: code or id; dimension at a cc1/cc2/bu grid: code or id; months: EVERY YYYY-MM of the year, a decimal string or null; other template fields are ignored) with grain and the template's version_token (REQUIRED: a version saved since is refused, read a fresh template), at most ${MAX_GRID_ROWS} rows; `
    + `or file_base64, the .xlsx template as base64 (at most ${(MAX_WORKBOOK_BASE64 / 1_000_000).toFixed(1)} million characters, about 2 MB of file: the MCP request is at most 3 MB), checked as the app checks an upload (another version's file, an altered _meta or _base sheet, wrong month headers or a damaged file is refused whole). `
    + 'TRAPS FIRST: a cell changes only where the file differs from what was downloaded (an .xlsx compares with its hidden _base, so a colleague\'s later save is never reverted; a cell changed both in the file and in the version is a conflict and takes the file\'s value); null or a blank cell CLEARS that month (not budgeted), "0.00" is a budgeted zero; rows left out are untouched. '
    + 'An unknown or ambiguous account or member, a non-income-statement account, a header or inactive account with no budget, an account budgeted at another level in this version (decision 4), a row listed twice or an amount that is not a decimal amount is refused PER ROW with the reason (i = the sheet row, or the 1-based position in rows); one refused row writes nothing (all or nothing). '
    + `At most ${MAX_SAVE_CELLS} changed cells per call (split a bigger import into files of fewer rows; never chunked for you). A budget holder imports only their own slices; a slice under review, a locked version or a reforecast's closed months are refused by the grid save. `
    + 'The save is a person\'s grid save as you (audited as you, in the version\'s history). Needs write:budgets and read:reports. A person approves the version in IsaFlow.',
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' },
      rows: {
        type: 'array', minItems: 1, maxItems: MAX_GRID_ROWS, description: 'get_budget_template\'s JSON rows, edited.',
        items: {
          type: 'object',
          properties: {
            ...Object.fromEntries(GRID_ROW_KEYS.map((k) => [k, {}])),
            account: { type: 'string', description: 'Account code or id.' },
            dimension: { type: ['string', 'null'], description: 'cc1 / cc2 / bu grid: the member code or id.' },
            months: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'Every YYYY-MM of the year: a decimal string, or null (not budgeted).' },
          },
          required: ['account', 'months'],
          additionalProperties: false,
        },
      },
      grain: { type: 'string', enum: [...TEMPLATE_GRAINS], description: 'With rows: the template\'s grain (default company).' },
      file_base64: { type: 'string', maxLength: MAX_WORKBOOK_BASE64, description: 'The .xlsx template, standard base64.' },
      file_name: { type: 'string', maxLength: 255 },
      version_token: { type: 'string', description: 'With rows: REQUIRED, the template\'s version_token. With a file: optional, refused when the version changed since.' },
      plan_hash: { type: 'string', description: 'The plan_hash your dry run returned. Required to apply an import of more than one cell.' },
      dry_run: { type: 'boolean', description: 'true: change nothing, answer the diff and the plan_hash.' },
      list_offset: { type: 'integer', minimum: 0, description: 'Page of the listed cells (default 0).' },
      list_limit: { type: 'integer', minimum: 1, maximum: DIFF_LIST_MAX, description: `Listed cells per reply (default ${DIFF_LIST_DEFAULT}).` },
      idempotency_key: { type: 'string' },
    },
    required: ['version_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const hasFile = args.file_base64 !== undefined, hasRows = args.rows !== undefined;
    if (hasFile === hasRows) return toolError('Send file_base64 (an .xlsx) or rows (the JSON grid), not both and not neither.');
    const versionToken = versionTokenArg(args);
    if (isResult(versionToken)) return versionToken;
    const planHash = planHashArg(args);
    if (isResult(planHash)) return planHash;
    let bytes: Buffer | null = null;
    if (hasFile) {
      const raw = args.file_base64;
      if (typeof raw === 'string' && raw.length > MAX_WORKBOOK_BASE64) {
        return toolError('The file is larger than one MCP request can carry (about 2 MB of .xlsx as base64; the request is at most 3 MB). Import it in parts: download templates for fewer members, or remove rows you are not changing.');
      }
      if (typeof raw !== 'string' || raw.length === 0 || raw.length % 4 !== 0 || !BASE64.test(raw)) return toolError('file_base64 must be the .xlsx file as standard base64.');
      bytes = Buffer.from(raw, 'base64');
      if ((typeof args.file_name === 'string' && args.file_name.toLowerCase().endsWith('.xls')) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
        return toolError('Old-style Excel .xls files are not supported. Save the template as .xlsx and send it again.');
      }
    } else if (versionToken === null) {
      return toolError('version_token is required with rows: send the version_token get_budget_template returned with them.');
    }
    const grain = (args.grain ?? 'company') as TemplateGrain;
    if (!TEMPLATE_GRAINS.includes(grain)) return toolError(`grain must be one of ${TEMPLATE_GRAINS.join(', ')}`);

    let model: GridReadModel;
    let src: ImportSource;
    let diff;
    try {
      const loaded = await loadModel(ctx, args.version_id);
      if (isResult(loaded)) return loaded;
      model = loaded;
      if (bytes) {
        if (!(await checkRateLimit(`budget-import:${ctx.userId}`, { max: IMPORT_RATE, windowSecs: 900 }))) {
          return toolError('Too many imports of a workbook; wait a few minutes and try again.');
        }
        const file = bytes;
        const wb = await BUDGET_SPREADSHEET_SLOT.run(() => readBudgetWorkbook(file), ctx.userId);
        src = workbookSource(model, model.version!.id, wb);
      } else {
        const lines = gridLines(model, grain, args.rows);
        if (typeof lines === 'string') return toolError(lines);
        src = { grain, readAt: versionToken!, base: 'current', lines };
      }
      diff = diffImportLines(model, src);
      assertHolderSlices(model, diff.preview.cells);
    } catch (err) {
      // Nothing is written before the save: every refusal here is the request's or the file's, answered as the import preview answers it.
      if (err instanceof SpreadsheetRefusedError || (err instanceof BudgetVersionError && err.code !== 'BUDGET_VERSION_NOT_FOUND')) return toolError(err.message);
      if (err instanceof BudgetVersionError || err instanceof FiscalYearLabelUnknownError) return toolError(NOT_FOUND);
      if (err instanceof CpuSlotBusyError) {
        return toolError(err.reason === 'owner-limit'
          ? 'You already have two spreadsheets being read or built; wait for one to finish.'
          : 'The server is busy reading other spreadsheets; try again in a moment (the JSON grid reads none).');
      }
      throw err;
    }

    const { preview, rowOf } = diff;
    const lineOf = new Map(src.lines.map((l) => [l.row, l]));
    const inputs: PlanInput[] = preview.cells.map((c) => ({
      index: rowOf.get(rowKeyOf(cellKey(c)))!, glAccountId: c.glAccountId, cc1Id: c.cc1Id, cc2Id: c.cc2Id, buId: c.buId, month: c.month,
      cents: c.amount === null ? null : toCents(c.amount),
    }));
    // An account the grid does not list gets PR 1's precise reason (unknown, not income statement, header, inactive,
    // outside a holder's slices) from one chart read, in place of the import's combined one.
    const find = codeIndex(model.accounts);
    const unlisted = src.lines.filter((l) => l.accountId === undefined && l.accountCode.trim() !== '' && find(l.accountCode) === undefined);
    const why = await explainMissingAccounts(ctx.companyId, [...new Set(unlisted.map((l) => l.accountCode))]);
    const unlistedRows = new Set(unlisted.map((l) => l.row));
    const rowRefusals: RowRefusal[] = preview.errors.map((e) => {
      const line = lineOf.get(e.row);
      const reason = line && unlistedRows.has(e.row) && e.column === COLUMN.accountCode ? why.get(line.accountCode) ?? e.message : e.message;
      return {
        index: e.row, account: line?.accountCode ?? '', month: isMonth(e.column) ? e.column : '',
        dimension: line?.dimensionCode ? `${src.grain} ${line.dimensionCode}` : null, reason,
      };
    });
    return runAmountWrite(ctx, {
      tool: 'import_budget_workbook', model, mode: 'merge', inputs, rowRefusals, dryRun: args.dry_run === true, versionToken, planHash,
      hashRequired: preview.cells.length > 1, page: page(args),
      extra: {
        format: bytes ? 'xlsx' : 'json', grain: src.grain, import_counts: preview.counts,
        warnings: preview.warnings.slice(0, WARNINGS_LISTED), warning_count: preview.warningCount,
        conflicts: conflictView(model, preview.conflicts), conflict_count: preview.conflicts.length,
      },
    });
  },
};
