/**
 * The three-way service (P6 spec §5, §7, §13; T12): one version's budgeted
 * balance sheet and cash flow, read-only. Fills `EngineInput` from:
 *   months        `versionMonths` (the version's registry year, 'YYYY-MM');
 *   pnl           the version's stored amounts via `readTrackingBudgets`, by canonical subtype (§13.6);
 *   lookback      `readTrackingActuals`, the 12 months before the first month (§13.8);
 *   opening       `readOpening` (bucketed, decision 10a) + the `getCashBalance` check (I7), then per version
 *                 the named income-tax / dividends payable accounts moved into their buckets (§5);
 *   assumptions   the stored document resolved up the scenario chain over the derived defaults (§13.21);
 *   loanSchedules `previewSchedule` / `amortise` (R6).
 * Everything that depends only on the company and fiscal year (`YearContext`)
 * is read once, so compare runs it once for up to three versions.
 * Money is integer cents; months 'YYYY-MM'.
 */
import { sql, type DbRow } from '@/lib/neon';
import { BudgetVersionError, type BudgetVersionKind, type BudgetVersionStatus } from '../budgetVersionTypes';
import { resolvePrimaryVersion } from '../budgetVersionScope';
import { versionMonths } from '../drivers/driverRecomputeService';
import { fiscalYearForDate } from '../../gl/fiscalYearRegistry';
import { readActuals, readVersionPnl } from './actualsLookback';
import { readChain, type StoredAssumptions } from './assumptionsRepo';
import { resolveAssumptions } from './assumptionsChain';
import type { ThreeWayAssumptions } from './assumptionsSchema';
import type { DerivedAssumptions } from './deriveCore';
import { deriveAssumptions, readCompanyProfile, type CompanyProfile } from './deriveAssumptions';
import { runThreeWay } from './engine';
import { readLoanSchedules } from './loanInputs';
import { addMonths } from './months';
import { openingCashCheck, readOpening, type OpeningCashCheck, type OpeningRead } from './openingBalances';
import { assertPayableAccounts, payableAccountsOf, resolvePayableConflict, type PayableAccountConflict } from './payableAccounts';
import { applyPayableAccounts } from './threeWayFolds';
import type { EngineOutput, LookbackMonth, UnmappedBalance } from './types';

export interface VersionHead {
  id: string;
  name: string;
  kind: BudgetVersionKind;
  status: BudgetVersionStatus;
  fiscalYear: number;
  isPrimary: boolean;
  basedOnVersionId: string | null;
}

export interface YearContext {
  fiscalYear: number;
  months: string[];
  profile: CompanyProfile;
  opening: OpeningRead;
  cashCheck: OpeningCashCheck;
  lookback: LookbackMonth[];
  derived: DerivedAssumptions;
}

/** Warnings the service adds to the engine's. */
export type ServiceWarning =
  | { code: 'opening_cash_difference'; differenceCents: number; accounts: string[] }
  | PayableAccountConflict;

export interface VersionRun {
  output: EngineOutput;
  /** Service warnings of this run (the year's cash check is added by the view). */
  warnings: PayableAccountConflict[];
  /** The opening's unmapped accounts after the named payable accounts moved out. */
  unmapped: UnmappedBalance[];
  assumptions: ThreeWayAssumptions;
  chain: string[];
  stored: StoredAssumptions | null;
}

function mapHead(r: DbRow): VersionHead {
  return {
    id: String(r.id).toLowerCase(), name: String(r.name), kind: String(r.kind) as BudgetVersionKind,
    status: String(r.status) as BudgetVersionStatus, fiscalYear: Number(r.fiscal_year), isPrimary: Boolean(r.is_primary),
    basedOnVersionId: r.based_on_version_id == null ? null : String(r.based_on_version_id).toLowerCase(),
  };
}

/** The company's versions among `ids`, in `ids` order; any not the company's is 404 (no data). */
export async function readVersionHeads(companyId: string, ids: readonly string[]): Promise<VersionHead[]> {
  const rows = (await sql`
    SELECT id::TEXT AS id, name, kind, status, fiscal_year, is_primary, based_on_version_id::TEXT AS based_on_version_id
      FROM budget_versions WHERE company_id = ${companyId}::UUID AND id = ANY(${ids.map((i) => i.toLowerCase())}::UUID[])
  `) as DbRow[];
  const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), mapHead(r)]));
  return ids.map((id) => {
    const head = byId.get(id.toLowerCase());
    if (!head) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
    return head;
  });
}

/** The named version, or the primary of `fiscalYear` (default: the year holding `today`). */
export async function resolveHead(companyId: string, opts: { versionId?: string; fiscalYear?: number }, today: string): Promise<VersionHead> {
  if (opts.versionId) return (await readVersionHeads(companyId, [opts.versionId]))[0] as VersionHead;
  const fy = opts.fiscalYear ?? (await fiscalYearForDate(companyId, today)).fiscalYear;
  const id = await resolvePrimaryVersion(companyId, fy);
  if (!id) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', `FY${fy} has no primary budget version`);
  return (await readVersionHeads(companyId, [id]))[0] as VersionHead;
}

/** Everything a run needs that depends only on the company and the fiscal year. */
export async function loadYearContext(companyId: string, fiscalYear: number, today: string): Promise<YearContext> {
  const months = await versionMonths(companyId, fiscalYear);
  const first = months[0] as string;
  const profile = await readCompanyProfile(companyId);
  const opening = await readOpening(companyId, first, today);
  const cashCheck = await openingCashCheck(companyId, first, opening);
  const actuals = await readActuals(companyId, first, opening.asAt);
  const derived = await deriveAssumptions(companyId, { profile, opening, trailing: actuals.trailing, priorYearEnd: addMonths(first, -1) });
  return { fiscalYear, months, profile, opening, cashCheck, lookback: actuals.lookback, derived };
}

/** One version through the engine over a year context of its own fiscal year. */
export async function runVersion(companyId: string, ctx: YearContext, head: VersionHead): Promise<VersionRun> {
  if (head.fiscalYear !== ctx.fiscalYear) throw new Error(`runVersion: version is FY${head.fiscalYear}, context FY${ctx.fiscalYear}`);
  const { versions, stored } = await readChain(companyId, head.id);
  const resolved = resolveAssumptions(head.id, versions, ctx.derived.assumptions);
  // The named payable accounts are re-checked on every run (retyped or re-parented since the save: 400).
  // One account in both slots (a base edited after its scenario was saved) is no 400: income tax keeps it.
  const { named, warnings } = resolvePayableConflict(payableAccountsOf(resolved.assumptions));
  await assertPayableAccounts(companyId, named);
  const opening = applyPayableAccounts(ctx.opening, named);
  const pnl = await readVersionPnl(companyId, ctx.fiscalYear, head.id, ctx.months);
  const loanSchedules = await readLoanSchedules(companyId, resolved.assumptions);
  const output = runThreeWay({
    months: ctx.months,
    entityType: ctx.profile.entityType,
    pnl,
    lookback: ctx.lookback,
    opening: { asAt: ctx.opening.asAt, provisional: ctx.opening.provisional, buckets: opening.buckets, unmapped: opening.unmapped },
    assumptions: resolved.assumptions,
    loanSchedules,
  });
  return { output, unmapped: opening.unmapped, warnings, assumptions: resolved.assumptions, chain: resolved.chain, stored };
}
