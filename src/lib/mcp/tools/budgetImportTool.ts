/**
 * MCP write tool import_budget_workbook (budget tools PR 2): the app's Excel import for an agent. The input is
 * the template as an .xlsx (base64, read and checked exactly as the import preview route reads it: the
 * spreadsheet limits, `_meta`, the signed `_base`, the month headers; one with `_meta` but no `_base` is refused as
 * tampered, review round 1), a free-form .xlsx (neither sheet: `budgetImportFreeform`, an explicit overwrite of the
 * version at the caller's version_token, review round 2) or get_budget_template's JSON grid, each row with its
 * signed base (`budgetWorkbookGrid`);
 * both become the import's own lines and base and go through the SAME resolve and 3-way diff
 * (`budgetImportDiff.diffImportLines`) and the preview's holder-slice check. The changed cells then go through
 * PR 1's one write path (`budgetAmountWrite.runAmountWrite`, mode merge): the dry run runs the real grid save
 * rolled back and answers the diff, totals and plan_hash; the live call is all or nothing, needs the plan_hash
 * always (round 2: a one-cell conflict was written before it was shown), is refused past MAX_SAVE_CELLS (never chunked), records the undo snapshot that
 * restore_budget_version reads, and the grid save writes its own audit row as the token user. The app's commit
 * sends the preview's cells to the save route in the same shape and order, so both leave the same rows.
 * Rate: `mcp-budget-import-xlsx:<user>` (60 / 15 min, charged once the spreadsheet slot is granted, as the route
 * charges after its slot) and `mcp-budget-import-json:<user>` (240 / 15 min), both before the model is read.
 */
import { checkRateLimit } from '@/lib/rateLimit';
import { BUDGET_SPREADSHEET_SLOT, CpuSlotBusyError } from '@/lib/withCpuSlot';
import { SpreadsheetRefusedError } from '@/lib/xlsxToCsv';
import { freeformLines, readImportWorkbook } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import { assertHolderSlices, diffImportLines, workbookSource, type ImportDiff, type ImportSource } from '@/modules/accounting/services/budgets/budgetImportDiff';
import { COLUMN, TEMPLATE_GRAINS, type TemplateGrain } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import { codeIndex } from '@/modules/accounting/services/budgets/codeIndex';
import { explainMissingAccounts } from '@/modules/accounting/services/budgets/budgetRefResolve';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { cellKey, rowKeyOf } from '@/modules/accounting/services/budgets/grid/cellKey';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import { MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSave';
import type { PlanInput } from '@/modules/accounting/services/budgets/cellWritePlan';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import type { McpTool, McpToolResult } from '../types';
import {
  BUDGET_WRITE_FENCE, DIFF_LIST_DEFAULT, DIFF_LIST_MAX, isMonth, isResult, MCP_SLOT_WAIT_MS, page, planHashArg, spreadsheetBusy, versionTokenArg,
} from './budgetToolArgs';
import type { RowRefusal } from './budgetDiffView';
import { loadModel, runAmountWrite } from './budgetAmountWrite';
import { conflictView, FREEFORM_NEEDS_TOKEN, FREEFORM_OVERWRITE, MAX_WORKBOOK_BASE64, NO_BASE_REFUSED, workbookBytes } from './budgetImportArgs';
import { GRID_ROW_KEYS, gridLines, MAX_GRID_ROWS } from './budgetWorkbookGrid';
import { NOT_FOUND, toolError } from './toolHelpers';

export { MAX_GRID_ROWS, MAX_WORKBOOK_BASE64 };

const RATE = { xlsx: { max: 60, windowSecs: 900 }, json: { max: 240, windowSecs: 900 } } as const;
const WARNINGS_LISTED = 20;

export const importBudgetWorkbookTool: McpTool = {
  name: 'import_budget_workbook',
  description:
    'Import an edited budget template into its budget version: the app\'s Excel import, for an agent. '
    + 'WORKFLOW: list_budget_versions → get_budget_template → edit → import_budget_workbook dry_run true (the cells it changes, section totals before and after, warnings, conflicts, plan_hash) → the same call with dry_run false and that plan_hash → get_budget / budget_variance to check; restore_budget_version undoes the import while nobody has changed the version since. '
    + `Send ONE of: rows, get_budget_template's JSON rows from any pages read at any time, in one call or several (each row: base EXACTLY as read, which ties it to its account and member and to the months it was read with; months: EVERY YYYY-MM of the year, a decimal string or null; account / dimension, if sent, must name the base's; other template fields are ignored; rows cannot be added: read the template row of the account), with grain, at most ${MAX_GRID_ROWS} rows and 3 MB; `
    + `or file_base64, an .xlsx as base64 (at most ${(MAX_WORKBOOK_BASE64 / 1_000_000).toFixed(1)} million characters, about 2 MB of file: the MCP request is at most 3 MB): either the template from get_budget_template format xlsx, checked as the app checks an upload (its hidden _meta sheet, signed over the version, year, grain and _base, and its _base sheet, the amounts as downloaded, must be as IsaFlow wrote them; one with _meta but no _base is refused as tampered; another version's file or wrong month headers is refused whole), `
    + 'or a FREE-FORM sheet (no _meta and no _base sheet): its first sheet, a header row with an account code column ("Account code", "Code" or "Account") and a column for EVERY month of the year (YYYY-MM, a date, or a month name with its year, or alone when it names one year month), at a cc1/cc2/bu grain (send grain) one dimension column, and only Account name, Name, Description, Section, Total, FY total, PY actual or Notes besides; anything else is refused naming its sheet, row and column. '
    + 'A free-form sheet HAS NO BASE: it OVERWRITES. version_token is REQUIRED with it and must be the version\'s token now (dry run and live); every cell it names is then set to the sheet\'s value even if a colleague changed that cell after you read the token; a BLANK cell KEEPS its amount, the text "clear" clears the month, "0" is a budgeted zero. '
    + 'TRAPS FIRST (template and JSON grid): a cell changes only where the file differs from what was read (the .xlsx\'s _base, a JSON row\'s base), so a colleague\'s later save is never reverted; a cell changed both in the file and in the version since is a conflict (listed, with its member) and takes the file\'s value; null or a blank cell CLEARS that month (not budgeted), "0.00" is a budgeted zero; rows left out are untouched; version_token is optional there and checked on the LIVE call only. '
    + 'EVERY live import needs the plan_hash of its dry run, even one of a single cell: the dry run is the preview (as in the app), and a conflict shows there before anything is written. '
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
            base: { type: 'string', description: 'The row\'s base exactly as get_budget_template returned it.' },
            account: { type: 'string', description: 'Optional: the base\'s account (code or id).' },
            dimension: { type: ['string', 'null'], description: 'Optional, cc1 / cc2 / bu grid: the base\'s member (code or id).' },
            months: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'Every YYYY-MM of the year: a decimal string, or null (not budgeted).' },
          },
          required: ['base', 'months'],
          additionalProperties: false,
        },
      },
      grain: { type: 'string', enum: [...TEMPLATE_GRAINS], description: 'With rows: the template\'s grain (default company).' },
      file_base64: { type: 'string', maxLength: MAX_WORKBOOK_BASE64, description: 'The .xlsx template, standard base64.' },
      file_name: { type: 'string', maxLength: 255 },
      version_token: { type: 'string', description: 'REQUIRED with a free-form .xlsx: the version\'s token now (dry run and live). Otherwise optional: the live call is refused when the version changed since.' },
      plan_hash: { type: 'string', description: 'The plan_hash your dry run returned. Required to apply ANY import, even of one cell.' },
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
    const bytes = hasFile ? workbookBytes(args.file_base64, args.file_name) : null;
    if (bytes !== null && isResult(bytes)) return bytes;
    const grain = (args.grain ?? 'company') as TemplateGrain;
    if (!TEMPLATE_GRAINS.includes(grain)) return toolError(`grain must be one of ${TEMPLATE_GRAINS.join(', ')}`);

    // Rate first (the routes' order: after the slot, before any read), then the model, then the file or the rows.
    const prepare = async (): Promise<McpToolResult | { model: GridReadModel; src: ImportSource; diff: ImportDiff; sheet: 'template' | 'free-form' | null }> => {
      if (!(await checkRateLimit(`mcp-budget-import-${bytes ? 'xlsx' : 'json'}:${ctx.userId}`, RATE[bytes ? 'xlsx' : 'json']))) {
        return toolError('Too many imports of a budget template; wait a few minutes and try again.');
      }
      const model = await loadModel(ctx, args.version_id);
      if (isResult(model)) return model;
      let src: ImportSource;
      let sheet: 'template' | 'free-form' | null = null;
      if (bytes) {
        const read = await readImportWorkbook(bytes);
        if (read.kind === 'template') {
          if (read.wb.base === null) return toolError(NO_BASE_REFUSED);
          src = workbookSource(model, model.version!.id, read.wb);
          sheet = 'template';
        } else {
          if (versionToken === null) return toolError(FREEFORM_NEEDS_TOKEN);
          src = { grain, readAt: versionToken, base: 'current', lines: freeformLines(model, grain, read.rows) };
          sheet = 'free-form';
        }
      } else {
        const g = gridLines(model, grain, args.rows);
        if (typeof g === 'string') return toolError(g);
        src = { grain, readAt: null, base: g.base, lines: g.lines };
      }
      const diff = diffImportLines(model, src);
      assertHolderSlices(model, diff.preview.cells);
      return { model, src, diff, sheet };
    };
    let prepared;
    try {
      prepared = bytes ? await BUDGET_SPREADSHEET_SLOT.run(prepare, ctx.userId, MCP_SLOT_WAIT_MS) : await prepare();
    } catch (err) {
      // Nothing is written before the save: every refusal here is the request's or the file's, answered as the import preview answers it.
      if (err instanceof SpreadsheetRefusedError || (err instanceof BudgetVersionError && err.code !== 'BUDGET_VERSION_NOT_FOUND')) return toolError(err.message);
      if (err instanceof BudgetVersionError || err instanceof FiscalYearLabelUnknownError) return toolError(NOT_FOUND);
      if (err instanceof CpuSlotBusyError) return spreadsheetBusy(err);
      throw err;
    }
    if (isResult(prepared)) return prepared;
    const { model, src, sheet, diff: { preview, rowOf } } = prepared;

    const lineOf = new Map(src.lines.map((l) => [l.row, l]));
    const inputs: PlanInput[] = preview.cells.map((c) => ({
      index: rowOf.get(rowKeyOf(cellKey(c)))!, glAccountId: c.glAccountId, cc1Id: c.cc1Id, cc2Id: c.cc2Id, buId: c.buId, month: c.month,
      cents: c.amount === null ? null : toCents(c.amount),
    }));
    // An account the grid does not list gets PR 1's precise reason (unknown, not income statement, header, inactive,
    // outside a holder's slices) from one chart read, in place of the import's combined one.
    const find = codeIndex(model.accounts);
    const listed = new Set(model.accounts.map((a) => a.id));
    const refOf = (l: (typeof src.lines)[number]) => l.accountId ?? l.accountCode;
    const unlisted = src.lines.filter((l) => (l.accountId !== undefined ? !listed.has(l.accountId) : l.accountCode.trim() !== '' && find(l.accountCode) === undefined));
    const why = await explainMissingAccounts(ctx.companyId, [...new Set(unlisted.map(refOf))]);
    const unlistedRows = new Set(unlisted.map((l) => l.row));
    const rowRefusals: RowRefusal[] = preview.errors.map((e) => {
      const line = lineOf.get(e.row);
      const reason = line && unlistedRows.has(e.row) && e.column === COLUMN.accountCode ? why.get(refOf(line)) ?? e.message : e.message;
      return {
        index: e.row, account: line?.accountCode ?? '', month: isMonth(e.column) ? e.column : '',
        dimension: line?.dimensionCode ? `${src.grain} ${line.dimensionCode}` : null, reason,
      };
    });
    // A change flagged possibleRevert needs a file with no _base, which is refused above: listed if one ever appears.
    const possibleRevert = preview.changes.filter((c) => c.possibleRevert).length;
    return runAmountWrite(ctx, {
      tool: 'import_budget_workbook', model, mode: 'merge', inputs, rowRefusals, dryRun: args.dry_run === true, versionToken, planHash,
      hashRequired: true, page: page(args), // round 2: every import is previewed by its dry run first, as in the app
      extra: {
        format: bytes ? 'xlsx' : 'json', ...(sheet ? { sheet } : {}), ...(sheet === 'free-form' ? { overwrite: FREEFORM_OVERWRITE } : {}), grain: src.grain, import_counts: preview.counts,
        warnings: preview.warnings.slice(0, WARNINGS_LISTED), warning_count: preview.warningCount,
        conflicts: conflictView(model, preview.conflicts), conflict_count: preview.conflicts.length,
        ...(possibleRevert > 0 ? { possible_revert: possibleRevert } : {}),
      },
    });
  },
};
