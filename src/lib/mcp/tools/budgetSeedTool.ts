/**
 * MCP write tool seed_budget: a NEW draft version seeded the way the app's create wizard seeds one
 * (`seedVersion`, the service the wizard route calls), from prior-year actuals or another version, with an
 * uplift %. Beyond the wizard (server-only `adjust`, seedAdjust.ts): an uplift per section or per account,
 * a fixed annual amount per account, and a flat seasonality. The new version is never made primary here
 * (set_primary_budget_version is the owner's). dry_run runs the real seed in a savepoint that is always
 * rolled back, so every rule of the live seed applies, and answers the totals it would create.
 */
import { seedVersion, type SeedInput } from '@/modules/accounting/services/budgets/seedVersion';
import type { SeedAdjustments } from '@/modules/accounting/services/budgets/seedAdjust';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { BudgetVersionError, BUDGET_VERSION_KINDS } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { refResolver, explainMissingAccounts } from '@/modules/accounting/services/budgets/budgetRefResolve';
import { BAND_ORDER, type Band, type BandTotals } from '@/modules/accounting/services/budgets/grid/subtotals';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import type { McpTool, McpToolContext } from '../types';
import { BUDGET_WRITE_FENCE, isResult, ownVersion, parseMoney, randText, roundingUnitArg, refText, ID_OR_CODE } from './budgetToolArgs';
import { ok, toolError } from './toolHelpers';

const PCT = { type: 'number', minimum: -100, maximum: 1000 };
const isPct = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -100 && v <= 1000 && Math.abs(v * 10_000 - Math.round(v * 10_000)) < 1e-6;
/** The wizard preview's notice: accounts whose last month the rounding put on the other side of zero (written as computed). */
const flipsOf = (flips: string[]) => (flips.length === 0 ? {} : {
  rounding_flips: flips.slice(0, 100), rounding_flips_total: flips.length,
  rounding_note: 'The rounding puts these accounts\' last month on the other side of zero; a smaller rounding_unit avoids it.',
});
const totalsView = (t: BandTotals) => Object.fromEntries(Object.entries(t.months).map(([m, values]) => [m, { year: randText(t.fy[m as keyof typeof t.fy]), months: values.map(randText) }]));

/** Account references (id or code) of the target year's chart to ids, or the first refusal. */
async function accountIds(ctx: McpToolContext, fiscalYear: number, refs: string[]): Promise<Map<string, string> | string> {
  const model = await loadGridReadModel(ctx.companyId, { fiscalYear }, 'totals');
  const resolver = refResolver(model);
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const ref of refs) {
    const found = resolver.account(ref);
    if (found === null) missing.push(ref);
    else if (!found.ok) return found.reason;
    else out.set(ref, found.item.id);
  }
  if (missing.length > 0) return (await explainMissingAccounts(ctx.companyId, missing)).get(missing[0]!) ?? `${missing[0]} cannot be budgeted`;
  return out;
}

/** The adjustments from the arguments; null when none (the wizard's own seed). */
async function adjustments(ctx: McpToolContext, args: Record<string, unknown>, fiscalYear: number): Promise<SeedAdjustments | null | string> {
  const list = (k: string): Array<Record<string, unknown>> | string => {
    const v = args[k] ?? [];
    return Array.isArray(v) && v.every((x) => x && typeof x === 'object') ? v as Array<Record<string, unknown>> : `${k} must be a list of objects`;
  };
  const sections = list('section_uplifts'), accounts = list('account_uplifts'), fixed = list('fixed_annual');
  for (const l of [sections, accounts, fixed]) if (typeof l === 'string') return l;
  const [s, a, f] = [sections, accounts, fixed] as Array<Array<Record<string, unknown>>>;
  const seasonality = args.seasonality ?? 'actuals';
  if (seasonality !== 'actuals' && seasonality !== 'flat') return 'seasonality must be actuals or flat';
  if (s!.length + a!.length + f!.length === 0 && seasonality === 'actuals') return null;
  const sectionUplift = new Map<Band, number>();
  for (const r of s!) {
    if (!(BAND_ORDER as readonly unknown[]).includes(r.section)) return `section must be one of ${BAND_ORDER.join(', ')}`;
    if (!isPct(r.uplift_pct)) return 'uplift_pct must be a number from -100 to 1000 (at most 4 decimals)';
    if (sectionUplift.has(r.section as Band)) return `section ${String(r.section)} is listed twice`;
    sectionUplift.set(r.section as Band, r.uplift_pct);
  }
  const read = [...a!, ...f!].map((r) => refText(r.account));
  const bad = read.find((r): r is { error: string } => 'error' in r);
  if (bad) return bad.error;
  const refs = read.map((r) => (r as { ref: string }).ref);
  if (refs.some((r) => r === '')) return 'each account_uplifts / fixed_annual row needs an account (id or code)';
  const ids = refs.length === 0 ? new Map<string, string>() : await accountIds(ctx, fiscalYear, refs);
  if (typeof ids === 'string') return ids;
  const accountUplift = new Map<string, number>();
  for (const r of a!) {
    if (!isPct(r.uplift_pct)) return 'uplift_pct must be a number from -100 to 1000 (at most 4 decimals)';
    const id = ids.get(String(r.account).trim())!;
    if (accountUplift.has(id)) return `account ${String(r.account)} is listed twice in account_uplifts`;
    accountUplift.set(id, r.uplift_pct);
  }
  const fixedAnnual = new Map<string, number>();
  for (const r of f!) {
    const money = parseMoney(r.amount);
    if ('error' in money) return `fixed_annual ${String(r.account)}: ${money.error}`;
    const id = ids.get(String(r.account).trim())!;
    if (fixedAnnual.has(id)) return `account ${String(r.account)} is listed twice in fixed_annual`;
    fixedAnnual.set(id, money.cents);
  }
  return { sectionUplift, accountUplift, fixedAnnual, seasonality };
}

export const seedBudgetTool: McpTool = {
  name: 'seed_budget',
  description:
    'Create a NEW draft budget version and fill it, as the app\'s create wizard does: from prior_year_actuals (the same calendar months a year earlier, leaf accounts only) or from another version (months by position), times (1 + uplift_pct/100). '
    + 'TRAPS FIRST: it always creates a new version (to change an existing one use set_budget_amounts); kind original is refused when the year has one; at a dimension grain an account with untagged prior-year activity is budgeted at company level (unassigned company, default) or keeps only its tagged rows (drop); headers and inactive accounts are skipped (counted). '
    + 'Adjustments: section_uplifts (turnover, cost_of_sales, other_income, operating_expense, other_expense) and account_uplifts override uplift_pct (account first); fixed_annual sets an account\'s annual total instead (shared over its dimension rows by the source\'s share); seasonality actuals (the source\'s monthly shape, default) or flat. '
    + 'Seasonality flat spreads over EVERY month of the target year. An account named in account_uplifts or fixed_annual must have a row in the source. '
    + 'Rounding (rounding_unit 1, 100 or 1000, default 1): months rounded, the LAST month takes the residue (rounding_flips names accounts it pushed past zero). Needs write:budgets and read:reports. WORKFLOW: dry_run true answers the cells and section totals it would create; then call with dry_run false. Not primary: an owner sets that, and a person approves it in IsaFlow.',
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      fiscal_year: { type: 'integer' }, name: { type: 'string', minLength: 1, maxLength: 120 }, kind: { type: 'string', enum: [...BUDGET_VERSION_KINDS] },
      source: { type: 'string', enum: ['prior_year_actuals', 'version'] },
      source_version_id: { type: 'string', format: 'uuid', description: 'source version: any year of the company.' },
      grain: { type: 'string', enum: ['company', 'cc1', 'cc2', 'bu'], description: 'prior_year_actuals only; default company.' },
      unassigned: { type: 'string', enum: ['company', 'drop'] },
      include_no_activity: { type: 'boolean', description: 'Also budget active accounts with no prior-year activity (zero rows).' },
      uplift_pct: PCT,
      section_uplifts: { type: 'array', items: { type: 'object', properties: { section: { type: 'string', enum: [...BAND_ORDER] }, uplift_pct: PCT }, required: ['section', 'uplift_pct'], additionalProperties: false } },
      account_uplifts: { type: 'array', items: { type: 'object', properties: { account: ID_OR_CODE, uplift_pct: PCT }, required: ['account', 'uplift_pct'], additionalProperties: false } },
      fixed_annual: { type: 'array', items: { type: 'object', properties: { account: ID_OR_CODE, amount: { type: 'string' } }, required: ['account', 'amount'], additionalProperties: false } },
      seasonality: { type: 'string', enum: ['actuals', 'flat'] },
      rounding_unit: { type: 'integer', enum: [1, 100, 1000] },
      dry_run: { type: 'boolean' }, idempotency_key: { type: 'string' },
    },
    required: ['fiscal_year', 'name', 'kind', 'source', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const fiscalYear = Number.isInteger(args.fiscal_year) ? Number(args.fiscal_year) : NaN;
    if (!(fiscalYear >= 1900 && fiscalYear <= 2200)) return toolError('fiscal_year must be a year label such as 2027');
    const unit = roundingUnitArg(args);
    if (isResult(unit)) return unit;
    const upliftPct = args.uplift_pct ?? 0;
    if (!isPct(upliftPct)) return toolError('uplift_pct must be a number from -100 to 1000 (at most 4 decimals)');
    if (args.include_no_activity !== undefined && typeof args.include_no_activity !== 'boolean') return toolError('include_no_activity must be true or false');
    let source: SeedInput['source'];
    if (args.source === 'prior_year_actuals') {
      const grain = args.grain ?? 'company', unassigned = args.unassigned ?? 'company';
      if (!['company', 'cc1', 'cc2', 'bu'].includes(grain as string)) return toolError('grain must be company, cc1, cc2 or bu');
      if (unassigned !== 'company' && unassigned !== 'drop') return toolError('unassigned must be company or drop');
      source = { type: 'py_actuals', upliftPct, grain: grain as 'company', unassigned };
    } else if (args.source === 'version') {
      const from = await ownVersion(ctx, args.source_version_id, 'source_version_id');
      if (isResult(from)) return from;
      source = { type: 'version', versionId: from.id, upliftPct };
    } else return toolError('source must be prior_year_actuals or version');
    let adjust: SeedAdjustments | null | string;
    try {
      adjust = await adjustments(ctx, args, fiscalYear);
    } catch (err) {
      if (err instanceof FiscalYearLabelUnknownError) return toolError(`No financial year is labelled ${fiscalYear}`);
      throw err;
    }
    if (typeof adjust === 'string') return toolError(adjust);
    const input: SeedInput = {
      fiscalYear, name: args.name, kind: args.kind, makePrimary: false, roundingUnit: unit, source,
      includeNoActivity: args.include_no_activity === true, ...(adjust ? { adjust } : {}),
    };
    const actor = { userId: ctx.userId, role: ctx.companyRole ?? '' };
    if (args.dry_run === true) {
      let preview: Record<string, unknown> = {};
      try {
        await inRolledBackSavepoint('mcp_budget_seed_dry', async () => {
          const r = await seedVersion(ctx.companyId, actor, input);
          const model = await loadGridReadModel(ctx.companyId, { versionId: r.versionId }, 'totals');
          preview = { cells: r.cells, skipped_accounts: r.skippedAccounts, accounts: new Set(model.cells.map((c) => c.glAccountId)).size, months: model.year.monthKeys,
            totals: totalsView(model.totals), ...flipsOf(r.roundingFlips) };
        });
      } catch (err) {
        if (err instanceof BudgetVersionError) return toolError(`The seed would be refused: ${err.message}`);
        if (err instanceof FiscalYearLabelUnknownError) return toolError(`No financial year is labelled ${fiscalYear}`);
        throw err;
      }
      return { ...ok({ dry_run: true, fiscal_year: fiscalYear, ...preview, next_step: 'Call again with dry_run false to create the version.' }), wroteNothing: true };
    }
    let r;
    try {
      r = await seedVersion(ctx.companyId, actor, input);
    } catch (err) {
      // Only the seed's reads (before its savepoint) look the year up: nothing is written yet.
      if (err instanceof FiscalYearLabelUnknownError) return toolError(`No financial year is labelled ${fiscalYear}`);
      throw err;
    }
    return ok({
      version_id: r.versionId, version_token: r.updatedAt, cells: r.cells, skipped_accounts: r.skippedAccounts, ...flipsOf(r.roundingFlips),
      next_step: 'A new draft version (not primary). Review it with get_budget; adjust with set_budget_amounts; a person approves it in IsaFlow.',
    });
  },
};
