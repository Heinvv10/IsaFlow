/**
 * MCP write tools for budget versions and notes (budget write tools PR 1): create_budget_version,
 * copy_budget_version, create_reforecast, add_budget_note. Each calls the service the matching UI route
 * calls (`createVersion`, `copyVersion`, `createReforecastFromActuals`, `setGridNote`) with the token user
 * as the actor, so the rules, the audit rows and the refusals are the app's. Ids the agent sends are
 * checked against the company first (shared NOT_FOUND). Service refusals are thrown: the registry's
 * savepoint rolls back anything a service began, and their (caller-facing) message reaches the agent.
 */
import { copyVersion, createVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { createReforecastFromActuals } from '@/modules/accounting/services/budgets/drivers/reforecastService';
import { setGridNote } from '@/modules/accounting/services/budgets/budgetNotes';
import { BUDGET_VERSION_KINDS } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { McpTool, McpToolContext } from '../types';
import { BUDGET_WRITE_SCOPE, figuresAllowed, randText, isResult, ownVersion, versionView } from './budgetToolArgs';
import { resolveRows } from './budgetCellArgs';
import { loadModel } from './budgetAmountWrite';
import { ok, toolError } from './toolHelpers';

const NAME = { type: 'string', minLength: 1, maxLength: 120 };
/** Unplaced actual lines named in a reforecast's reply (the rest are counted). */
const MAX_UNPLACED_LISTED = 100;
const KIND = { type: 'string', enum: [...BUDGET_VERSION_KINDS] };
const actor = (ctx: McpToolContext) => ({ userId: ctx.userId, role: ctx.companyRole ?? '' });
const yearOf = (v: unknown): number | null => (Number.isInteger(v) && Number(v) >= 1900 && Number(v) <= 2200 ? Number(v) : null);

export const createBudgetVersionTool: McpTool = {
  name: 'create_budget_version',
  description:
    'Create a new DRAFT budget version for a financial year (fiscal_year is the year\'s label, e.g. 2027). kind: original (at most one per year), reforecast or scenario; name unique in the year (1-120 characters). '
    + 'Without copy_from_version_id it is empty; with it, every amount of that version is copied exactly (it must be of the SAME year: to copy into another year, or with an uplift, use seed_budget). '
    + 'Next: set amounts (set_budget_amounts / set_budget_annual / seed_budget into a new version). The new version is not primary; a person approves it in ISAFlow.',
  scope: BUDGET_WRITE_SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: { fiscal_year: { type: 'integer' }, name: NAME, kind: KIND, copy_from_version_id: { type: 'string', format: 'uuid' }, idempotency_key: { type: 'string' } },
    required: ['fiscal_year', 'name', 'kind', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const year = yearOf(args.fiscal_year);
    if (year === null) return toolError('fiscal_year must be a year label such as 2027');
    if (args.copy_from_version_id !== undefined) {
      const source = await ownVersion(ctx, args.copy_from_version_id, 'copy_from_version_id');
      if (isResult(source)) return source;
      if (source.fiscalYear !== year) {
        return toolError(`copy_from_version_id is a FY${source.fiscalYear} version; a copy stays in its source's year. Use seed_budget to copy into FY${year}.`);
      }
      return ok({ version: versionView(await copyVersion(ctx.companyId, source.id, { name: args.name, kind: args.kind }, actor(ctx)), figuresAllowed(ctx)) });
    }
    return ok({ version: versionView(await createVersion(ctx.companyId, { fiscalYear: year, name: args.name, kind: args.kind }, actor(ctx)), figuresAllowed(ctx)) });
  },
};

export const copyBudgetVersionTool: McpTool = {
  name: 'copy_budget_version',
  description:
    'Copy a budget version into a new DRAFT of the same financial year, every amount at every level copied exactly; the copy records the source as its basis. '
    + 'For another year or an uplift use seed_budget; for actuals in the closed months use create_reforecast.',
  scope: BUDGET_WRITE_SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: { version_id: { type: 'string', format: 'uuid' }, name: NAME, kind: KIND, idempotency_key: { type: 'string' } },
    required: ['version_id', 'name', 'kind', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const source = await ownVersion(ctx, args.version_id);
    if (isResult(source)) return source;
    return ok({ version: versionView(await copyVersion(ctx.companyId, source.id, { name: args.name, kind: args.kind }, actor(ctx)), figuresAllowed(ctx)) });
  },
};

export const createReforecastTool: McpTool = {
  name: 'create_reforecast',
  description:
    'Create a reforecast from actuals: a new DRAFT version (kind reforecast) of the source\'s year whose CLOSED months hold the ledger\'s posted actuals at each row\'s level and whose open months keep the source\'s amounts; the source\'s drivers and planned hires are copied and recomputed. '
    + 'TRAPS: closed months are read-only in the new version; actuals with no dimension on an account budgeted by a dimension are not placed: they are listed as unplaced (amounts only with read:reports). rolling true makes it the year\'s auto-rolling forecast (one per year; refused when another exists). The app\'s "New reforecast" does exactly this.',
  scope: BUDGET_WRITE_SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: { version_id: { type: 'string', format: 'uuid', description: 'The source version.' }, name: NAME, rolling: { type: 'boolean' }, idempotency_key: { type: 'string' } },
    required: ['version_id', 'name', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (args.rolling !== undefined && typeof args.rolling !== 'boolean') return toolError('rolling must be true or false');
    const source = await ownVersion(ctx, args.version_id);
    if (isResult(source)) return source;
    const made = await createReforecastFromActuals(ctx.companyId, actor(ctx), source.id, { name: args.name, rolling: args.rolling === true });
    const figures = figuresAllowed(ctx);
    return ok({
      version: versionView(made.version, figures), rolling: made.rolling, closed_months: made.closedMonths, cells: made.cells,
      unplaced_total: made.unplaced.length,
      unplaced: made.unplaced.slice(0, MAX_UNPLACED_LISTED).map((u) => ({
        account: u.accountCode, account_name: u.accountName, level: u.level, month: u.month, ...(figures ? { amount: randText(u.amount) } : {}),
      })),
      driver_warnings: made.warnings.length, headcount_as_of: made.headcountAsOf,
    });
  },
};

export const addBudgetNoteTool: McpTool = {
  name: 'add_budget_note',
  description:
    'Set, replace or clear (note null or blank) the budget note of one account for the version\'s financial year. TRAPS: a note belongs to the account and YEAR, so every version of that year shows it (a locked one too); '
    + 'only an active leaf revenue or expense account takes a note; at most 2 000 characters (trimmed); refused on a locked version. It does not change the version_token.',
  scope: BUDGET_WRITE_SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' }, account: { type: 'string', description: 'Id or code.' },
      note: { type: ['string', 'null'], maxLength: 10000 }, idempotency_key: { type: 'string' },
    },
    required: ['version_id', 'account', 'note', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (args.note !== null && typeof args.note !== 'string') return toolError('note must be text or null');
    if (typeof args.note === 'string' && args.note.length > 10_000) return toolError('note is at most 2 000 characters');
    const model = await loadModel(ctx, args.version_id);
    if (isResult(model)) return model;
    const ref = (await resolveRows(ctx, model, [{ index: 0, account: args.account }])).get(0);
    if (!ref || !('glAccountId' in ref)) return toolError(ref?.reason ?? 'account cannot take a note');
    const saved = await setGridNote(ctx.companyId, { userId: ctx.userId }, { versionId: model.version!.id, glAccountId: ref.glAccountId, note: args.note as string | null });
    return ok({ version_id: model.version!.id, account_id: ref.glAccountId, note: saved.note });
  },
};

export const BUDGET_VERSION_TOOLS: McpTool[] = [createBudgetVersionTool, copyBudgetVersionTool, createReforecastTool, addBudgetNoteTool];
