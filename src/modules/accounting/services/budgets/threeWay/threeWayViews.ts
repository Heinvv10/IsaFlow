/**
 * What the three-way routes answer (P6 spec §7), built over `threeWayService`.
 * Money is integer CENTS, months 'YYYY-MM'. Nothing here writes.
 *
 * - `getThreeWay`: one version's run (`GET /budget-three-way`).
 * - `getAssumptionsView`: stored + resolved + derived (`GET …/assumptions`).
 * - `deriveView`: the derived defaults and their evidence (`POST …/derive`).
 * - `compareView`: 1–3 versions of one company and fiscal year (`GET …/compare`).
 */
import { resolveAssumptions } from './assumptionsChain';
import type { ThreeWayAssumptions } from './assumptionsSchema';
import { readChain, type StoredAssumptions } from './assumptionsRepo';
import { compareVersions, MAX_COMPARE_VERSIONS, type CompareResult } from './compare';
import type { DeriveEvidence } from './deriveCore';
import { agingEvidence, type AgingEvidence } from './deriveAssumptions';
import type { OpeningCashCheck } from './openingBalances';
import { threeWayInputError } from './serviceErrors';
import type { OpeningTotals } from './threeWayFolds';
import {
  loadYearContext, readVersionHeads, resolveHead, runVersion, type ServiceWarning, type VersionHead, type VersionRun, type YearContext,
} from './threeWayService';
import { payableAccountsOf, resolvePayableConflict, type PayableAccountConflict } from './payableAccounts';
import type {
  BalanceSheetSections, Buckets, CashFlowMonth, IndirectCashFlow, LookbackMonth, PnlMonth, Runway, TaxEvent, ThreeWayWarning, UnmappedBalance, VatSettlement,
} from './types';

export type { ServiceWarning } from './threeWayService';

export interface ThreeWayView {
  version: VersionHead;
  months: string[];
  /** The engine's lookback (actual months before the first month, ex VAT, cents): the days-method evidence. */
  lookback: LookbackMonth[];
  opening: {
    asAt: string; provisional: boolean; buckets: Buckets; balanceSheet: BalanceSheetSections; totals: OpeningTotals;
    equity: { posted: number; derivedRetainedEarnings: number }; unmapped: UnmappedBalance[];
  };
  pnl: Array<PnlMonth & { month: string; netProfit: number }>;
  balanceSheet: Array<{ month: string; closing: Buckets; sections: BalanceSheetSections }>;
  cashFlow: {
    direct: Array<{ month: string } & Omit<CashFlowMonth, 'indirect'>>;
    indirect: Array<{ month: string } & IndirectCashFlow>;
  };
  runway: Runway;
  checks: { balanced: boolean; unbalancedMonths: string[]; openingCash: OpeningCashCheck };
  warnings: Array<ThreeWayWarning | ServiceWarning>;
  vatSettlements: VatSettlement[];
  taxEvents: TaxEvent[];
  assumptions: { resolved: ThreeWayAssumptions; chain: string[]; stored: StoredAssumptions | null };
}

/** A run's warnings: the engine's, the run's own (payable conflict) and the year's opening cash check. */
function runWarnings(ctx: YearContext, run: VersionRun): Array<ThreeWayWarning | ServiceWarning> {
  const warnings: Array<ThreeWayWarning | ServiceWarning> = [...run.output.warnings, ...run.warnings];
  if (ctx.cashCheck.difference !== 0) {
    warnings.push({ code: 'opening_cash_difference', differenceCents: ctx.cashCheck.difference, accounts: ctx.cashCheck.accounts.map((a) => a.accountCode) });
  }
  return warnings;
}

export async function getThreeWay(companyId: string, opts: { versionId?: string; fiscalYear?: number }, today: string): Promise<ThreeWayView> {
  const head = await resolveHead(companyId, opts, today);
  const ctx = await loadYearContext(companyId, head.fiscalYear, today);
  const run = await runVersion(companyId, ctx, head);
  const o = run.output;
  const unbalancedMonths = o.months.filter((m) => m.balanceSheet.check !== 0).map((m) => m.month);
  const warnings = runWarnings(ctx, run);
  return {
    version: head,
    months: ctx.months,
    lookback: ctx.lookback,
    opening: {
      asAt: o.opening.asAt, provisional: o.opening.provisional, buckets: o.opening.buckets, balanceSheet: o.opening.balanceSheet,
      totals: ctx.opening.totals, equity: ctx.opening.equity, unmapped: run.unmapped,
    },
    pnl: o.months.map((m) => ({ month: m.month, ...m.pnl })),
    balanceSheet: o.months.map((m) => ({ month: m.month, closing: m.closing, sections: m.balanceSheet })),
    cashFlow: {
      direct: o.months.map((m) => {
        const { indirect: _indirect, ...direct } = m.cashFlow;
        return { month: m.month, ...direct };
      }),
      indirect: o.months.map((m) => ({ month: m.month, ...m.cashFlow.indirect })),
    },
    runway: o.runway,
    checks: { balanced: unbalancedMonths.length === 0, unbalancedMonths, openingCash: ctx.cashCheck },
    warnings,
    vatSettlements: o.vatSettlements,
    taxEvents: o.taxEvents,
    assumptions: { resolved: run.assumptions, chain: run.chain, stored: run.stored },
  };
}

export interface AssumptionsView {
  version: VersionHead;
  stored: StoredAssumptions | null;
  resolved: ThreeWayAssumptions;
  chain: string[];
  derived: { assumptions: ThreeWayAssumptions; evidence: DeriveEvidence };
  /** The resolved chain's payable-account conflict, as a run reports it (the run keeps income tax). */
  warnings: PayableAccountConflict[];
}

export async function getAssumptionsView(companyId: string, versionId: string, today: string): Promise<AssumptionsView> {
  const head = (await readVersionHeads(companyId, [versionId]))[0] as VersionHead;
  const ctx = await loadYearContext(companyId, head.fiscalYear, today);
  const { versions, stored } = await readChain(companyId, head.id);
  const resolved = resolveAssumptions(head.id, versions, ctx.derived.assumptions);
  const { warnings } = resolvePayableConflict(payableAccountsOf(resolved.assumptions));
  return { version: head, stored, resolved: resolved.assumptions, chain: resolved.chain, derived: ctx.derived, warnings };
}

export interface DeriveView {
  version: VersionHead;
  assumptions: ThreeWayAssumptions;
  evidence: DeriveEvidence & { aging: AgingEvidence };
}

export async function deriveView(companyId: string, versionId: string, today: string): Promise<DeriveView> {
  const head = (await readVersionHeads(companyId, [versionId]))[0] as VersionHead;
  const ctx = await loadYearContext(companyId, head.fiscalYear, today);
  return {
    version: head,
    assumptions: ctx.derived.assumptions,
    evidence: { ...ctx.derived.evidence, aging: await agingEvidence(companyId, ctx.opening.asAt) },
  };
}

export interface CompareView extends Omit<CompareResult, 'versions'> {
  fiscalYear: number;
  /** Each version's KPIs and series, with its run's warnings (as GET /budget-three-way answers them). */
  versions: Array<CompareResult['versions'][number] & { warnings: Array<ThreeWayWarning | ServiceWarning> }>;
}

export async function compareView(companyId: string, versionIds: readonly string[], today: string): Promise<CompareView> {
  const ids = [...new Set(versionIds.map((v) => v.toLowerCase()))];
  if (ids.length < 1 || ids.length > MAX_COMPARE_VERSIONS) throw threeWayInputError(`Compare takes 1 to ${MAX_COMPARE_VERSIONS} different versions`);
  const heads = await readVersionHeads(companyId, ids);
  const fiscalYear = (heads[0] as VersionHead).fiscalYear;
  if (heads.some((h) => h.fiscalYear !== fiscalYear)) throw threeWayInputError('Compare versions of one financial year only');
  const ctx = await loadYearContext(companyId, fiscalYear, today);
  const runs: VersionRun[] = [];
  for (const h of heads) runs.push(await runVersion(companyId, ctx, h));
  const result = compareVersions(heads.map((h, i) => ({ versionId: h.id, name: h.name, output: (runs[i] as VersionRun).output })));
  return { fiscalYear, ...result, versions: result.versions.map((v, i) => ({ ...v, warnings: runWarnings(ctx, runs[i] as VersionRun) })) };
}
