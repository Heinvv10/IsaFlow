/**
 * MCP write tools: set_budget_amounts and set_budget_annual (budget write tools PR 1). Both run the one
 * write path in budgetAmountWrite.ts (dry run = the real grid save rolled back; live = the dry run's
 * token, all or nothing, the save's own audit row as the token user, an undo snapshot).
 */
import { loadPriorActuals, type PriorGrain } from '@/modules/accounting/services/budgets/priorActuals';
import { spreadAnnual, type AnnualSpread } from '@/modules/accounting/services/budgets/annualSpread';
import { MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSave';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import { WRITE_MODES, type PlanInput, type WriteMode } from '@/modules/accounting/services/budgets/cellWritePlan';
import type { McpTool } from '../types';
import { residueFlipsSign } from '@/modules/accounting/services/budgets/grid/spread';
import { DIM_REF, ID_OR_CODE, BUDGET_WRITE_FENCE, isResult, parseMoney, planHashArg, roundingUnitArg, versionTokenArg } from './budgetToolArgs';
import { dimensionLabel, resolveRows, parseAmountCells, type ResolvedRef } from './budgetCellArgs';
import { DIFF_LIST_DEFAULT, DIFF_LIST_MAX, type RowRefusal } from './budgetDiffView';
import { loadModel, runAmountWrite, type RoundingNotice } from './budgetAmountWrite';
import { toolError } from './toolHelpers';
import { listPage } from './budgetPaging';

const PAGING = {
  list_offset: { type: 'integer', minimum: 0, description: 'Page of the listed cells (default 0).' },
  list_limit: { type: 'integer', minimum: 1, maximum: DIFF_LIST_MAX, description: `Listed cells per reply (default ${DIFF_LIST_DEFAULT}).` },
};
const COMMON = {
  version_id: { type: 'string', format: 'uuid' },
  plan_hash: { type: 'string', description: 'The plan_hash your dry run returned. Required to apply a write of more than one cell; refused when the plan changed since.' },
  version_token: { type: 'string', description: 'Optional: refused when the version changed since you read it.' },
  dry_run: { type: 'boolean', description: 'true: change nothing, answer the diff and the plan_hash.' },
  idempotency_key: { type: 'string' },
  ...PAGING,
};

const page = (args: Record<string, unknown>) => listPage(args, DIFF_LIST_DEFAULT, DIFF_LIST_MAX);

export const setBudgetAmountsTool: McpTool = {
  name: 'set_budget_amounts',
  description:
    'Set monthly budget amounts on one budget version. TRAPS FIRST: amounts are decimal STRINGS ("1250.00", at most 2 decimals), never numbers; months are YYYY-MM inside the version\'s financial year; '
    + 'an account is budgeted at ONE level per version (company level, or one cc1, cc2 or bu member; never two dimensions on one cell); a header account (budget its sub-accounts), an inactive one, or a non-income-statement account is refused per cell with the reason; '
    + 'a write is ALL OR NOTHING: one refused cell writes nothing. '
    + 'WORKFLOW: 1) dry_run true: answers what the save would ACTUALLY leave: counts (added, changed, removed, unchanged, recomputed, refused), the cells (paged: list_offset; a driver\'s recomputed dependents too), section totals per month before and after, and plan_hash; '
    + '2) the same call with dry_run false and that plan_hash (required when more than one cell is listed). If the budget or the request changed since, the call is refused ("plan changed since your dry run"): dry-run again. '
    + 'MODES: merge (default) sets the listed cells, amount null clears that cell; add adds amount to what the cell holds now; replace makes each listed ACCOUNT hold exactly the listed cells, clearing every other cell of that account in the version (any month or dimension; the way to move an account to another level); a reforecast\'s closed months are never cleared. '
    + `At most ${MAX_SAVE_CELLS} changed cells per call (split larger writes; a call carries at most 100 000 argument values, so about 19 000 cells that each name a dimension). A budget holder writes only their own slices; a slice under review is refused. `
    + 'The save is a person\'s grid save as you (audited as you); restore_budget_version undoes the latest write while nobody has changed the version since. Needs write:budgets and read:reports. A person approves the version in IsaFlow.',
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      ...COMMON,
      mode: { type: 'string', enum: [...WRITE_MODES] },
      cells: {
        type: 'array', minItems: 1, maxItems: MAX_SAVE_CELLS,
        items: {
          type: 'object',
          properties: {
            account: ID_OR_CODE, month: { type: 'string', description: 'YYYY-MM' },
            amount: { type: ['string', 'null'], description: 'Decimal string; null clears the cell (merge, replace).' },
            cc1: DIM_REF, cc2: DIM_REF, bu: DIM_REF,
          },
          required: ['account', 'month', 'amount'],
          additionalProperties: false,
        },
      },
    },
    required: ['version_id', 'cells', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const mode = (args.mode ?? 'merge') as WriteMode;
    if (!WRITE_MODES.includes(mode)) return toolError(`mode must be one of ${WRITE_MODES.join(', ')}`);
    if (!Array.isArray(args.cells) || args.cells.length === 0) return toolError('cells must list at least one cell');
    if (args.cells.length > MAX_SAVE_CELLS) return toolError(`cells lists ${args.cells.length} cells; one call writes at most ${MAX_SAVE_CELLS}. Split it.`);
    const versionToken = versionTokenArg(args);
    if (isResult(versionToken)) return versionToken;
    const planHash = planHashArg(args);
    if (isResult(planHash)) return planHash;
    const model = await loadModel(ctx, args.version_id);
    if (isResult(model)) return model;
    const { inputs, refusals } = await parseAmountCells(ctx, model, args.cells);
    return runAmountWrite(ctx, {
      tool: 'set_budget_amounts', model, mode, inputs, rowRefusals: refusals, dryRun: args.dry_run === true, versionToken, planHash,
      hashRequired: !(args.cells.length === 1 && mode !== 'replace'), page: page(args),
    });
  },
};

const GRAIN_OF = (r: ResolvedRef): PriorGrain => (r.cc1Id ? 'cc1' : r.cc2Id ? 'cc2' : r.buId ? 'bu' : 'company');
const MAX_ANNUAL_ROWS = 1000;

/** A weight list: numbers ≥ 0 with at most 4 decimals, scaled to whole numbers. */
function weightsOf(raw: unknown): number[] | string {
  if (!Array.isArray(raw)) return 'weights must be a list of numbers, one per month';
  const out: number[] = [];
  for (const w of raw) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1e9) return 'each weight must be a number of 0 or more';
    const scaled = Math.round(w * 10_000);
    if (Math.abs(scaled - w * 10_000) > 1e-6) return 'a weight has at most 4 decimals';
    out.push(scaled);
  }
  return out;
}

export const setBudgetAnnualTool: McpTool = {
  name: 'set_budget_annual',
  description:
    'Set an ANNUAL budget per account (optionally at one cc1, cc2 or bu member) on one budget version, spread over the version\'s months. TRAPS FIRST: amount is a decimal STRING; every month of the row is SET (existing months of that row are overwritten); '
    + 'an account already budgeted at another level in this version is refused (move it with set_budget_amounts mode replace); a reforecast\'s closed months are read-only, so use set_budget_amounts there; one refused row writes nothing. '
    + 'spread: flat (even), prior_year (the same calendar months a year earlier: refused for a row with no prior-year activity or mixed signs, never guessed), or weights (one number per month). '
    + 'Rounding (rounding_unit 1, 100 or 1000 rand, default 1): every month but the last is rounded and the LAST month takes the residue, so the months sum to the amount exactly. '
    + 'A row whose rounding leaves the LAST month on the other side of zero is written and named in notices (as the grid warns); a smaller rounding_unit avoids it. '
    + 'WORKFLOW as set_budget_amounts: dry_run true (diff, totals, plan_hash), then apply with dry_run false and the plan_hash; restore_budget_version undoes the latest write. Needs write:budgets and read:reports.',
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      ...COMMON,
      rounding_unit: { type: 'integer', enum: [1, 100, 1000] },
      rows: {
        type: 'array', minItems: 1, maxItems: MAX_ANNUAL_ROWS,
        items: {
          type: 'object',
          properties: {
            account: ID_OR_CODE, amount: { type: 'string', description: 'The annual amount, decimal string.' },
            spread: { type: 'string', enum: ['flat', 'prior_year', 'weights'] },
            weights: { type: 'array', items: { type: 'number', minimum: 0 }, description: 'spread weights: one per month of the year.' },
            cc1: DIM_REF, cc2: DIM_REF, bu: DIM_REF,
          },
          required: ['account', 'amount', 'spread'],
          additionalProperties: false,
        },
      },
    },
    required: ['version_id', 'rows', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!Array.isArray(args.rows) || args.rows.length === 0) return toolError('rows must list at least one account');
    if (args.rows.length > MAX_ANNUAL_ROWS) return toolError(`rows lists ${args.rows.length} rows; one call takes at most ${MAX_ANNUAL_ROWS}`);
    const unit = roundingUnitArg(args);
    if (isResult(unit)) return unit;
    const versionToken = versionTokenArg(args);
    if (isResult(versionToken)) return versionToken;
    const planHash = planHashArg(args);
    if (isResult(planHash)) return planHash;
    const model = await loadModel(ctx, args.version_id);
    if (isResult(model)) return model;
    const rows: Array<Record<string, unknown> & { index: number }> = args.rows.map((r, index) => ({ ...((r && typeof r === 'object' ? r : {}) as Record<string, unknown>), index }));
    const refs = await resolveRows(ctx, model, rows.map((r) => ({ index: r.index, account: r.account, cc1: r.cc1, cc2: r.cc2, bu: r.bu })));
    const months = model.year.monthKeys;
    const prior = new Map<PriorGrain, Map<string, number[]>>();
    const priorOf = async (ref: ResolvedRef): Promise<number[]> => {
      const grain = GRAIN_OF(ref);
      if (!prior.has(grain)) {
        const read = await loadPriorActuals(ctx.companyId, model.year.fiscalYear, grain);
        const byRow = new Map<string, number[]>();
        for (const c of read.cells) {
          const key = `${c.glAccountId}|${c.dimensionId ?? ''}`;
          const series = byRow.get(key) ?? Array<number>(months.length).fill(0);
          const at = months.indexOf(c.month);
          if (at >= 0) series[at] = toCents(c.amount);
          byRow.set(key, series);
        }
        prior.set(grain, byRow);
      }
      return prior.get(grain)!.get(`${ref.glAccountId}|${ref.cc1Id ?? ref.cc2Id ?? ref.buId ?? ''}`) ?? Array<number>(months.length).fill(0);
    };
    const inputs: PlanInput[] = [];
    const refusals: RowRefusal[] = [];
    const notices: RoundingNotice[] = [];
    for (const r of rows) {
      const refuse = (reason: string) => refusals.push({ index: r.index, account: String(r.account ?? ''), month: 'year', dimension: dimensionLabel({ index: r.index, account: r.account, cc1: r.cc1, cc2: r.cc2, bu: r.bu }), reason });
      const ref = refs.get(r.index);
      if (!ref || !('glAccountId' in ref)) { refuse(ref?.reason ?? 'unresolved'); continue; }
      const money = parseMoney(r.amount);
      if ('error' in money) { refuse(money.error); continue; }
      let spread: AnnualSpread;
      if (r.spread === 'flat') spread = { kind: 'flat' };
      else if (r.spread === 'prior_year') spread = { kind: 'prior_year', priorCents: await priorOf(ref) };
      else if (r.spread === 'weights') {
        const weights = weightsOf(r.weights);
        if (typeof weights === 'string') { refuse(weights); continue; }
        spread = { kind: 'weights', weights };
      } else { refuse('spread must be flat, prior_year or weights'); continue; }
      const result = spreadAnnual(money.cents, months.length, spread, unit);
      if (!result.ok) { refuse(result.reason); continue; }
      if (residueFlipsSign(money.cents, result.months)) {
        notices.push({ i: r.index, account: String(r.account ?? ''), reason: `The R${unit} rounding puts the last month on the other side of zero; a smaller rounding unit avoids it.` });
      }
      result.months.forEach((cents, i) => inputs.push({ index: r.index, ...ref, month: months[i]!, cents }));
    }
    return runAmountWrite(ctx, {
      tool: 'set_budget_annual', model, mode: 'merge', inputs, rowRefusals: refusals, dryRun: args.dry_run === true, versionToken, planHash,
      hashRequired: true, page: page(args), notices,
    });
  },
};
