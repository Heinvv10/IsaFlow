/**
 * MCP three-way budget tools (budget tools PR 3), over the services the app's budget-three-way routes call, gated
 * by the company's `budgets_three_way` flag first as those routes are (`passThreeWayGate`):
 *  - get_three_way (read:reports): one version's budgeted balance sheet and cash flow (`getThreeWay`, GET /budget-three-way);
 *  - set_three_way_assumptions (write): `saveAssumptions` (PUT …/assumptions) as the token user: its savepoint, the
 *    version lock (locked refused), the row token compare-and-set, the chain check, one audit row; dry run rolled back;
 *  - derive_three_way (read, budget writers only as the app's withWriteAccess): `deriveView` (POST …/derive), which
 *    proposes and never saves.
 * Money is decimal text both ways (budgetThreeWayWire); typed three-way refusals are answered with their reason.
 */
import { localISODate } from '@/lib/dateUtils';
import { canWrite } from '@/lib/auth/writeRoles';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { THREE_WAY_FEATURE } from '@/modules/accounting/services/budgets/threeWay/routeSchemas';
import { deriveView, getThreeWay } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { readChain, saveAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsRepo';
import { parseStoredDoc } from '@/modules/accounting/services/budgets/threeWay/assumptionsChain';
import { isVersionToken } from '@/modules/accounting/services/budgets/gridErrors';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import type { McpTool, McpToolContext, McpToolResult } from '../types';
import { BUDGET_READ_SCOPE, BUDGET_WRITE_FENCE, isResult, ownVersion } from './budgetToolArgs';
import { centsDeep, docFromWire, docToWire } from './budgetThreeWayWire';
import { changedSections, threeWayRefusal } from './budgetThreeWayRefusal';
import { ok, toolError } from './toolHelpers';

export const THREE_WAY_SECTIONS = ['opening', 'pnl', 'balance_sheet', 'cash_flow', 'runway', 'checks', 'warnings', 'vat_settlements', 'tax_events', 'assumptions', 'lookback'] as const;
/** Long lists in a run's answer are cut here (their totals say how many there are). */
export const THREE_WAY_LIST_CAP = 50;
const NOT_ENABLED = 'The balance sheet and cash budget is not enabled for this company';

async function gate(ctx: McpToolContext): Promise<McpToolResult | null> {
  return (await hasFeature(ctx.companyId, THREE_WAY_FEATURE)) ? null : toolError(NOT_ENABLED);
}

/** Runs `fn`; a typed three-way refusal becomes its answer (nothing was written: reads, or the save's own savepoint). */
async function answering(fn: () => Promise<McpToolResult>, prefix = ''): Promise<McpToolResult> {
  try {
    return await fn();
  } catch (err) {
    const refusal = threeWayRefusal(err);
    if (refusal !== null) return toolError(`${prefix}${refusal}`);
    throw err;
  }
}

const cap = <T>(list: readonly T[]) => list.slice(0, THREE_WAY_LIST_CAP);
const capWarning = (w: Record<string, unknown>) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Array.isArray(v) ? cap(v) : v]));

export const getThreeWayTool: McpTool = {
  name: 'get_three_way',
  description:
    'One budget version\'s three-way forecast, as the app\'s Balance sheet & cash page shows it: the opening balance sheet, the budgeted P&L, the projected balance sheet and cash flow (direct and indirect) per month, runway, checks and warnings, VAT settlements and tax events, and the assumptions it ran on (resolved, the scenario chain, the stored document). '
    + 'TRAPS FIRST: it is computed now from the STORED assumptions (set_three_way_assumptions; with none stored, the derived defaults) and the version\'s amounts, so it changes when either does; a scenario reads its base\'s assumptions with its own overrides; '
    + 'the opening is the posted balance sheet the day before the first month (provisional, and warned, when that is after today); warnings are not errors (negative cash is shown, never funded). Needs the company\'s balance sheet and cash budget feature. '
    + `Money is decimal text (balances debit-positive: liabilities and equity negative), months YYYY-MM. version_id, or fiscal_year for that year's primary. include picks sections (default all but lookback); lists over ${THREE_WAY_LIST_CAP} entries are cut (with a total).`,
  scope: BUDGET_READ_SCOPE,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' }, fiscal_year: { type: 'integer' },
      include: { type: 'array', items: { type: 'string', enum: [...THREE_WAY_SECTIONS] } },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const off = await gate(ctx);
    if (off) return off;
    const include = Array.isArray(args.include) ? args.include : THREE_WAY_SECTIONS.filter((s) => s !== 'lookback');
    const unknown = include.find((s) => !(THREE_WAY_SECTIONS as readonly unknown[]).includes(s));
    if (unknown !== undefined) return toolError(`include: ${String(unknown).slice(0, 40)} is not one of ${THREE_WAY_SECTIONS.join(', ')}`);
    let opts: { versionId?: string; fiscalYear?: number };
    if (args.version_id !== undefined) {
      const v = await ownVersion(ctx, args.version_id);
      if (isResult(v)) return v;
      opts = { versionId: v.id };
    } else if (Number.isInteger(args.fiscal_year) && Number(args.fiscal_year) >= 1900 && Number(args.fiscal_year) <= 2200) {
      opts = { fiscalYear: Number(args.fiscal_year) };
    } else return toolError('Pass version_id, or fiscal_year as a year label such as 2027');
    return answering(async () => {
      const r = await getThreeWay(ctx.companyId, opts, localISODate());
      const has = (s: string) => include.includes(s);
      const { unmapped, ...opening } = r.opening;
      return ok({
        version: r.version, months: r.months,
        ...(has('opening') ? { opening: { ...(centsDeep(opening) as object), unmapped: centsDeep(cap(unmapped)), unmapped_total: unmapped.length } } : {}),
        ...(has('pnl') ? { pnl: centsDeep(r.pnl) } : {}),
        ...(has('balance_sheet') ? { balance_sheet: centsDeep(r.balanceSheet) } : {}),
        ...(has('cash_flow') ? { cash_flow: centsDeep(r.cashFlow) } : {}),
        ...(has('runway') ? { runway: centsDeep(r.runway) } : {}),
        ...(has('checks') ? { checks: centsDeep({ ...r.checks, openingCash: { ...r.checks.openingCash, accounts: cap(r.checks.openingCash.accounts) } }) } : {}),
        ...(has('warnings') ? { warnings: centsDeep(r.warnings.map((w) => capWarning(w as unknown as Record<string, unknown>))) } : {}),
        ...(has('vat_settlements') ? { vat_settlements: centsDeep(r.vatSettlements) } : {}),
        ...(has('tax_events') ? { tax_events: centsDeep(r.taxEvents) } : {}),
        ...(has('assumptions') ? {
          assumptions: {
            resolved: docToWire(r.assumptions.resolved), chain: r.assumptions.chain,
            stored: r.assumptions.stored ? { doc: docToWire(r.assumptions.stored.doc), assumptions_token: r.assumptions.stored.updatedAt, updated_by: r.assumptions.stored.updatedBy } : null,
          },
        } : {}),
        ...(has('lookback') ? { lookback: centsDeep(r.lookback) } : {}),
      });
    });
  },
};

export const setThreeWayAssumptionsTool: McpTool = {
  name: 'set_three_way_assumptions',
  description:
    'Save one budget version\'s three-way assumptions (debtor / creditor / inventory days, VAT, payroll statutory share, income tax, capex, loans, equity, minimum cash), the document the app\'s Balance sheet & cash assumptions panel saves. '
    + 'ASSUMPTIONS COME FIRST: get_three_way computes the forecast from the STORED assumptions, and derive_three_way only proposes a document (it saves nothing): save the proposal, or your edit of it, here before reading the forecast. '
    + 'TRAPS: doc is the WHOLE document (schemaVersion 1, every section; a scenario may send { schemaVersion: 1, overrides } of its base instead), it replaces what is stored; money fields (capex amountExVat, planned loan principal, share issue and dividend amount, minimumCash value) are decimal STRINGS, days and shares numbers; '
    + 'every value carries its provenance ({ value, source: derived | manual }); unknown keys are refused; refused on a locked version. assumptions_token is the stored document\'s token as you read it (get_three_way assumptions.stored), null when none is stored: refused when it moved. '
    + 'dry_run true runs the save and rolls it back (the changed sections, nothing kept). The save does not change the version_token or any amount, and restore_budget_version does not undo it: the reply carries the previous document. Audited as you. Needs the balance sheet and cash budget feature, write:budgets and read:reports.',
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' },
      doc: { type: 'object', description: 'The assumptions document (money as decimal strings).' },
      assumptions_token: { type: ['string', 'null'], description: 'The stored document\'s token as read; null when none is stored.' },
      dry_run: { type: 'boolean' }, idempotency_key: { type: 'string' },
    },
    required: ['version_id', 'doc', 'assumptions_token', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const off = await gate(ctx);
    if (off) return off;
    if (!('assumptions_token' in args)) return toolError('assumptions_token is required: the stored document\'s token as you read it, or null when none is stored');
    const token = args.assumptions_token;
    if (token !== null && (typeof token !== 'string' || token.length > 40 || !isVersionToken(token))) return toolError('assumptions_token must be the token get_three_way returned, or null');
    if (typeof args.doc !== 'object' || args.doc === null || Array.isArray(args.doc)) return toolError('doc must be the assumptions document (an object)');
    const version = await ownVersion(ctx, args.version_id);
    if (isResult(version)) return version;
    const wire = docFromWire(args.doc);
    if ('errors' in wire) return toolError(`The assumptions document is refused: ${wire.errors.slice(0, 20).join('; ')}`);
    let parsed;
    try {
      parsed = parseStoredDoc(wire.doc);
    } catch (err) {
      const refusal = threeWayRefusal(err);
      if (refusal !== null) return toolError(refusal);
      throw err;
    }
    const before = (await readChain(ctx.companyId, version.id)).stored;
    const input = { versionId: version.id, doc: wire.doc, expectedUpdatedAt: token as string | null };
    const summary = { version_id: version.id, changed_sections: changedSections(before?.doc ?? null, parsed), previous: before ? docToWire(before.doc) : null };
    if (args.dry_run === true) {
      return answering(async () => {
        await inRolledBackSavepoint('mcp_three_way_dry', () => saveAssumptions(ctx.companyId, ctx.userId, input));
        return { ...ok({ dry_run: true, ...summary, assumptions_token: token, next_step: 'Call again with dry_run false to save.' }), wroteNothing: true };
      }, 'The save would be refused: ');
    }
    // saveAssumptions runs in its own savepoint: a refusal it raises rolled its write back, so it is answered.
    return answering(async () => {
      const saved = await saveAssumptions(ctx.companyId, ctx.userId, input);
      return ok({ ...summary, assumptions: docToWire(saved.doc), assumptions_token: saved.updatedAt, next_step: 'get_three_way now computes the forecast from these assumptions.' });
    });
  },
};

export const deriveThreeWayTool: McpTool = {
  name: 'derive_three_way',
  description:
    'Propose three-way assumptions for a budget version from the company\'s history (the app\'s Derive): debtor and creditor days from the trailing turnover and purchases and the opening balances, VAT from the company\'s settings and VAT201s, the payroll statutory share from EMP201s, the income-tax and dividends payable accounts by name, with the evidence. '
    + 'TRAPS: it SAVES NOTHING and the forecast does not use it until the assumptions are saved: assumptions come before derive\'s effect, so pass the proposal (edited or not) to set_three_way_assumptions. Too little history gives defaults (insufficientHistory). '
    + 'Owners, admins and managers only, as in the app. Money is decimal text. Needs the balance sheet and cash budget feature and read:reports.',
  scope: BUDGET_READ_SCOPE,
  write: false,
  inputSchema: { type: 'object', properties: { version_id: { type: 'string', format: 'uuid' } }, required: ['version_id'], additionalProperties: false },
  handler: async (args, ctx) => {
    const off = await gate(ctx);
    if (off) return off;
    if (!canWrite(ctx.companyRole)) return toolError('derive_three_way is for owners, admins and managers, as the app\'s Derive is');
    const version = await ownVersion(ctx, args.version_id);
    if (isResult(version)) return version;
    return answering(async () => {
      const d = await deriveView(ctx.companyId, version.id, localISODate());
      return ok({
        version: d.version, assumptions: docToWire(d.assumptions), evidence: centsDeep(d.evidence),
        next_step: 'Nothing was saved. Save these (or your edit) with set_three_way_assumptions; get_three_way then computes from them.',
      });
    });
  },
};

export const THREE_WAY_TOOLS = { read: [getThreeWayTool, deriveThreeWayTool], write: [setThreeWayAssumptionsTool] };
