/**
 * The create wizard's server side (Budgets P2 spec 8): creates a DRAFT version and its amounts in
 * one transaction, computing every month with the grid's `uplift` (decision 5: target =
 * roundToUnit(sum x (1 + pct/100)), months 1..n-1 rounded to the unit, the last month takes the
 * residue, negative months kept). Sources: prior-year actuals, another version (same year, or
 * another by month position), or blank. Series building is seedSeries.ts.
 *
 * Writer rules (module notes): the year registry is held first; nothing is written until every
 * input is checked and every amount computed (a 4xx is committed by withAuth); the writes then
 * run in one savepoint, so a refusal after the version insert (a name clash, a grain clash, the
 * lock trigger) rolls the version back with it. A same-year copy at 0% is P1's `copyVersion`
 * (exact: cents and dimensions kept, no rounding). Audit: createVersion/copyVersion write the
 * version's row; a seed that inserts amounts adds one more with the source and the totals.
 * `makePrimary` is owner/admin, checked before any write (P1's `setPrimary` checks it again).
 */
import { sql, withSavepoint } from '@/lib/neon';
import { getFiscalYear } from '../gl/fiscalYearRegistry';
import { toBudgetYearInfo } from '../core/budgetYears';
import { monthKeyToDate } from '../reports/budgetPeriodWindow';
import { auditBudgetWrite, holdYearRegistry } from './budgetVersionScope';
import { copyVersion, createVersion, getVersion, parseVersionInput, setPrimary, type VersionActor } from './budgetVersions';
import { BudgetVersionError, mapBudgetDbError } from './budgetVersionTypes';
import { ROUNDING_UNITS, type RoundingUnit } from './grid/cents';
import { uplift } from './grid/spread';
import type { PriorGrain } from './priorActuals';
import { holdSourceVersion, loadSeedAccounts, pySeries, versionSeries, type SeedSeries, type UnassignedRule } from './seedSeries';

export type SeedSource =
  | { type: 'py_actuals'; upliftPct: number; grain: PriorGrain; unassigned?: UnassignedRule }
  | { type: 'version'; versionId: string; upliftPct: number }
  | { type: 'blank' };

export interface SeedInput {
  fiscalYear: number;
  name: unknown;
  kind: unknown;
  makePrimary: boolean;
  source: SeedSource;
  roundingUnit: RoundingUnit;
  includeNoActivity?: boolean;
}

export interface SeedResult {
  versionId: string;
  /** The version's token after the seed (P1's UTC ISO text, microseconds), as the read model and the save use it. */
  updatedAt: string;
  /** Amount rows in the new version. */
  cells: number;
  /** Accounts with PY activity that were not seeded because they are headers or inactive (decision 18). */
  skippedAccounts: number;
}

const APPROVERS = new Set(['owner', 'admin']);
const input400 = (message: string) => new BudgetVersionError('BUDGET_VERSION_INPUT', message);

interface SeedCell { series: SeedSeries; position: number; cents: number }

/** Runs `uplift` over each series; a refusal names the account. */
function upliftAll(series: readonly SeedSeries[], pct: number, unit: RoundingUnit, labels: ReadonlyMap<string, string>): SeedCell[] {
  const cells: SeedCell[] = [];
  for (const s of series) {
    const result = uplift(s.cents, pct, unit);
    if (!result.ok) throw input400(`Account ${labels.get(s.glAccountId) ?? s.glAccountId}: ${result.reason}`);
    result.months.forEach((cents, i) => cells.push({ series: s, position: s.positions[i]!, cents }));
  }
  return cells;
}

async function insertCells(companyId: string, versionId: string, userId: string, months: readonly string[], cells: readonly SeedCell[]): Promise<void> {
  if (cells.length === 0) return;
  // Whole cents travel as integers and are divided in NUMERIC, so no float reaches the column.
  await sql`
    INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, amount, created_by)
    SELECT ${companyId}::UUID, ${versionId}::UUID, t.a, t.c1, t.c2, t.b, t.m, t.cents::NUMERIC / 100, ${userId}
      FROM unnest(${cells.map((c) => c.series.glAccountId)}::UUID[], ${cells.map((c) => c.series.cc1Id)}::UUID[],
                  ${cells.map((c) => c.series.cc2Id)}::UUID[], ${cells.map((c) => c.series.buId)}::UUID[],
                  ${cells.map((c) => monthKeyToDate(months[c.position]!))}::DATE[], ${cells.map((c) => c.cents)}::BIGINT[])
           AS t(a, c1, c2, b, m, cents)
  `;
}

interface Plan {
  /** Null: an exact copy of `copyOf` (P1's copyVersion), nothing computed here. */
  cells: SeedCell[] | null;
  copyOf: string | null;
  skipped: number;
  months: string[];
}

/** Reads and computes everything; writes nothing. */
async function plan(companyId: string, input: SeedInput): Promise<Plan> {
  const year = await getFiscalYear(companyId, input.fiscalYear);
  if (!year) throw input400(`No financial year is labelled ${input.fiscalYear}`);
  const months = toBudgetYearInfo(year).monthKeys;
  const { source } = input;
  if (source.type === 'blank') return { cells: [], copyOf: null, skipped: 0, months };
  if (!Number.isFinite(source.upliftPct) || source.upliftPct < -100 || source.upliftPct > 1000) {
    throw input400('The uplift must be between -100% and 1000%');
  }
  const accounts = await loadSeedAccounts(companyId);
  const labels = new Map([...accounts].map(([id, a]) => [id, a.label]));
  if (source.type === 'py_actuals') {
    const { series, skipped } = await pySeries(companyId, input.fiscalYear, accounts, {
      grain: source.grain, unassigned: source.unassigned ?? 'company', includeNoActivity: input.includeNoActivity === true,
    });
    return { cells: upliftAll(series, source.upliftPct, input.roundingUnit, labels), copyOf: null, skipped, months };
  }
  const from = await getVersion(companyId, source.versionId);
  if (from.fiscalYear === input.fiscalYear && source.upliftPct === 0) return { cells: null, copyOf: from.id, skipped: 0, months };
  await holdSourceVersion(companyId, from.id);
  const series = await versionSeries(companyId, from.id, from.fiscalYear, months.length);
  return { cells: upliftAll(series, source.upliftPct, input.roundingUnit, labels), copyOf: null, skipped: 0, months };
}

const rand = (cents: number): string => (cents / 100).toFixed(2);

async function write(companyId: string, actor: VersionActor, input: SeedInput, p: Plan, name: string, kind: string): Promise<SeedResult> {
  let cells = 0;
  let versionId: string;
  if (p.copyOf) {
    const copy = await copyVersion(companyId, p.copyOf, { name, kind }, actor);
    versionId = copy.id;
    cells = copy.amountCount;
  } else {
    const version = await createVersion(companyId, { fiscalYear: input.fiscalYear, name, kind }, actor);
    versionId = version.id;
    const planned = p.cells ?? [];
    await insertCells(companyId, versionId, actor.userId, p.months, planned);
    cells = planned.length;
    if (cells > 0) {
      const { source } = input;
      await auditBudgetWrite(companyId, actor.userId, 'update', versionId, input.fiscalYear, {
        seed: source.type, upliftPct: String(source.type === 'blank' ? 0 : source.upliftPct), roundingUnit: String(input.roundingUnit),
        grain: source.type === 'py_actuals' ? source.grain : 'copy', cells: String(cells),
        accounts: String(new Set(planned.map((c) => c.series.glAccountId)).size), total: rand(planned.reduce((s, c) => s + c.cents, 0)),
        ...(source.type === 'version' ? { copiedFrom: source.versionId } : {}),
      });
    }
  }
  if (input.makePrimary) await setPrimary(companyId, versionId, actor);
  return { versionId, updatedAt: (await getVersion(companyId, versionId)).updatedAt, cells, skippedAccounts: p.skipped };
}

export async function seedVersion(companyId: string, actor: VersionActor, input: SeedInput): Promise<SeedResult> {
  await holdYearRegistry(companyId);
  const { name, kind } = parseVersionInput(input.name, input.kind);
  if (!(ROUNDING_UNITS as readonly number[]).includes(input.roundingUnit)) throw input400('roundingUnit must be 1, 100 or 1000');
  if (input.makePrimary && !APPROVERS.has(actor.role)) {
    throw new BudgetVersionError('BUDGET_VERSION_FORBIDDEN', 'Only an owner or admin can make a budget version primary');
  }
  const p = await plan(companyId, input);
  try {
    return await withSavepoint('budget_grid_seed', () => write(companyId, actor, input, p, name, kind));
  } catch (err) {
    return mapBudgetDbError(err);
  }
}
