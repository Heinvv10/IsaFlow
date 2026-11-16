/**
 * The create wizard's server side (Budgets P2 spec 8): creates a DRAFT version and its amounts in
 * one transaction, computing every month with the grid's `uplift` (decision 5: target =
 * roundToUnit(sum x (1 + pct/100)), months 1..n-1 rounded to the unit, the last month takes the
 * residue, negative months kept). Sources: prior-year actuals, another version (same year, or
 * another by month position), or blank. Series building is seedSeries.ts.
 *
 * Writer rules (module notes): the year registry is held first, then every version row lock the
 * seed needs, in one ordered statement (`lockSeedVersions`), before the source is read; nothing
 * is written until every input is checked and every amount computed (a 4xx is committed by
 * withAuth); the writes then run in one savepoint, so a refusal after the version insert (a name
 * clash, a grain clash, the lock trigger) rolls the version back with it. A same-year copy at 0% is P1's `copyVersion`
 * (exact: cents and dimensions kept, no rounding). Audit: createVersion/copyVersion write the
 * version's row; a seed that inserts amounts adds one more with the source and the totals.
 * `makePrimary` is owner/admin, checked before any write (P1's `setPrimary` checks it again).
 * Lineage (D2): every version seed records `based_on_version_id` = the locked source, uplift or
 * not, any year (PY and blank: null). Notes (D5): inside the savepoint, after the amounts and
 * before `setPrimary`, a seed into another year carries the source year's notes of the seeded
 * leaf accounts where the target year has none (`carryNotes`; PY's source year is the prior year).
 */
import { sql, withSavepoint } from '@/lib/neon';
import { getFiscalYear, priorFiscalYear } from '../gl/fiscalYearRegistry';
import { toBudgetYearInfo } from '../core/budgetYears';
import { monthKeyToDate } from '../reports/budgetPeriodWindow';
import { auditBudgetWrite, holdYearRegistry } from './budgetVersionScope';
import { carryNotes } from './budgetNotes';
import { copyVersion, createVersion, getVersion, parseVersionInput, setPrimary, type VersionActor } from './budgetVersions';
import { BudgetVersionError, mapBudgetDbError } from './budgetVersionTypes';
import { inputError } from './gridErrors';
import { MAX_IMPORT_CELLS } from './gridSaveValidate';
import { ROUNDING_UNITS, type RoundingUnit } from './grid/cents';
import { uplift } from './grid/spread';
import type { PriorGrain } from './priorActuals';
import { loadSeedAccounts, lockSeedVersions, pySeries, versionSeries, type SeedAccount, type SeedSeries, type UnassignedRule } from './seedSeries';
import { adjustSeedSeries, roundingFlips, type SeedAdjustments, type SeedCell } from './seedAdjust';

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
  /**
   * Server callers only (the MCP seed_budget tool; the wizard route never sends it): per-section or
   * per-account uplift, fixed annual amounts, flat seasonality (seedAdjust.ts). Absent: the wizard's seed.
   */
  adjust?: SeedAdjustments;
}

export interface SeedResult {
  versionId: string;
  /** The version's token after the seed (P1's UTC ISO text, microseconds), as the read model and the save use it. */
  updatedAt: string;
  /** Amount rows in the new version. */
  cells: number;
  /** Accounts with PY activity that were not seeded because they are headers or inactive (decision 18). */
  skippedAccounts: number;
  /**
   * Accounts ("code name") whose last seeded month the rounding put on the other side of zero: the notice the
   * wizard preview gives (seedPreview.ts). The cells are written as computed; empty for an exact copy.
   */
  roundingFlips: string[];
}

const APPROVERS = new Set(['owner', 'admin']);

const labelsOf = (accounts: ReadonlyMap<string, SeedAccount>) => new Map([...accounts].map(([id, a]) => [id, a.label]));

/** The seed's cells: the wizard's single uplift, or (server callers) with the adjustments applied. */
function seedCells(
  series: readonly SeedSeries[], input: SeedInput, pct: number, accounts: ReadonlyMap<string, SeedAccount>, monthCount: number,
): SeedCell[] {
  if (!input.adjust) return upliftAll(series, pct, input.roundingUnit, labelsOf(accounts));
  return adjustSeedSeries(series, pct, input.roundingUnit, input.adjust, accounts, monthCount);
}

/** Runs `uplift` over each series; a refusal names the account. */
function upliftAll(series: readonly SeedSeries[], pct: number, unit: RoundingUnit, labels: ReadonlyMap<string, string>): SeedCell[] {
  const cells: SeedCell[] = [];
  for (const s of series) {
    const result = uplift(s.cents, pct, unit);
    if (!result.ok) throw inputError(`Account ${labels.get(s.glAccountId) ?? s.glAccountId}: ${result.reason}`);
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
  /** The year whose notes the seeded accounts carry into the target (D5): the source version's, PY's prior year; null for blank. */
  notesFrom: number | null;
  /** seedAdjust.roundingFlips of the computed cells. */
  flips: string[];
}

/** One seed holds what one import may (the grid, the template and a chained commit are sized to it). */
function assertSeedSize(cells: number, exactCopy = false): void {
  if (cells <= MAX_IMPORT_CELLS) return;
  // An exact copy computes no grain or activity filter, so the advice for a computed plan would mean nothing.
  throw inputError(exactCopy
    ? `This version holds ${cells} cells, more than one seed can copy (${MAX_IMPORT_CELLS})`
    : `This seed would create ${cells} cells, more than the ${MAX_IMPORT_CELLS} one budget version is built for; seed a dimension grain with fewer members, or leave out accounts with no activity`);
}

/** Reads and computes everything; writes nothing. `sourceYear`: the locked source version's year label. */
async function plan(companyId: string, input: SeedInput, sourceYear: number | null): Promise<Plan> {
  const year = await getFiscalYear(companyId, input.fiscalYear);
  if (!year) throw inputError(`No financial year is labelled ${input.fiscalYear}`);
  const months = toBudgetYearInfo(year).monthKeys;
  const { source } = input;
  if (source.type === 'blank') return { cells: [], copyOf: null, skipped: 0, months, notesFrom: null, flips: [] };
  if (!Number.isFinite(source.upliftPct) || source.upliftPct < -100 || source.upliftPct > 1000) {
    throw inputError('The uplift must be between -100% and 1000%');
  }
  const accounts = await loadSeedAccounts(companyId);
  if (source.type === 'py_actuals') {
    const { series, skipped } = await pySeries(companyId, input.fiscalYear, accounts, {
      grain: source.grain, unassigned: source.unassigned ?? 'company', includeNoActivity: input.includeNoActivity === true,
    });
    const notesFrom = (await priorFiscalYear(companyId, year)).fiscalYear;
    const cells = seedCells(series, input, source.upliftPct, accounts, months.length);
    return { cells, copyOf: null, skipped, months, notesFrom, flips: roundingFlips(cells, labelsOf(accounts)) };
  }
  if (sourceYear === null) throw new Error('seedVersion: the source version was not locked');
  if (sourceYear === input.fiscalYear && isExactCopy(input)) {
    // The exact copy computes no cells here; count the source's (it is locked) against the same cap.
    const rows = (await sql`
      SELECT COUNT(*)::int AS n FROM budget_month_amounts WHERE company_id = ${companyId}::UUID AND version_id = ${source.versionId}::UUID
    `) as Array<{ n: number }>;
    assertSeedSize(Number(rows[0]?.n ?? 0), true);
    return { cells: null, copyOf: source.versionId, skipped: 0, months, notesFrom: sourceYear, flips: [] };
  }
  const series = await versionSeries(companyId, source.versionId, sourceYear, months.length);
  const cells = seedCells(series, input, source.upliftPct, accounts, months.length);
  return { cells, copyOf: null, skipped: 0, months, notesFrom: sourceYear, flips: roundingFlips(cells, labelsOf(accounts)) };
}

const rand = (cents: number): string => (cents / 100).toFixed(2);

/** The adjustment inputs in the seed's audit row (each list capped at 2 000 characters). */
function adjustAudit(a: SeedAdjustments): Record<string, string> {
  const list = (m: ReadonlyMap<string, number> | undefined, fmt: (v: number) => string) =>
    [...(m ?? new Map<string, number>())].map(([k, v]) => `${k}:${fmt(v)}`).join(';').slice(0, 2000);
  return {
    seasonality: a.seasonality ?? 'actuals',
    sectionUplifts: list(a.sectionUplift as ReadonlyMap<string, number> | undefined, String),
    accountUplifts: list(a.accountUplift, String),
    fixedAnnual: list(a.fixedAnnual, rand),
  };
}

/** A version seed at 0% with no adjustments: in the same year it is P1's exact copy (cents and dimensions kept, no rounding). */
function isExactCopy(input: SeedInput): boolean {
  return input.source.type === 'version' && input.source.upliftPct === 0 && !input.adjust;
}

async function write(companyId: string, actor: VersionActor, input: SeedInput, p: Plan, name: string, kind: string): Promise<SeedResult> {
  let cells = 0;
  let versionId: string;
  if (p.copyOf) {
    const copy = await copyVersion(companyId, p.copyOf, { name, kind }, actor);
    versionId = copy.id;
    cells = copy.amountCount;
  } else {
    // Lineage (D2): a version seed records its source (locked by lockSeedVersions), uplift or not, any year.
    const basedOn = input.source.type === 'version' ? input.source.versionId : null;
    const version = await createVersion(companyId, { fiscalYear: input.fiscalYear, name, kind }, actor, basedOn);
    versionId = version.id;
    const planned = p.cells ?? [];
    await insertCells(companyId, versionId, actor.userId, p.months, planned);
    cells = planned.length;
    const seeded = [...new Set(planned.map((c) => c.series.glAccountId))];
    const notesCarried = p.notesFrom === null ? 0 : await carryNotes(companyId, actor.userId, p.notesFrom, input.fiscalYear, seeded);
    if (cells > 0) {
      const { source } = input;
      await auditBudgetWrite(companyId, actor.userId, 'update', versionId, input.fiscalYear, {
        seed: source.type, upliftPct: String(source.type === 'blank' ? 0 : source.upliftPct), roundingUnit: String(input.roundingUnit),
        grain: source.type === 'py_actuals' ? source.grain : 'copy', cells: String(cells),
        accounts: String(seeded.length), total: rand(planned.reduce((s, c) => s + c.cents, 0)), notesCarried: String(notesCarried),
        ...(source.type === 'version' ? { copiedFrom: source.versionId } : {}),
        ...(input.adjust ? adjustAudit(input.adjust) : {}),
      });
    }
  }
  if (input.makePrimary) await setPrimary(companyId, versionId, actor);
  return { versionId, updatedAt: (await getVersion(companyId, versionId)).updatedAt, cells, skippedAccounts: p.skipped, roundingFlips: p.flips };
}

export async function seedVersion(companyId: string, actor: VersionActor, input: SeedInput): Promise<SeedResult> {
  await holdYearRegistry(companyId);
  const { name, kind } = parseVersionInput(input.name, input.kind);
  if (!(ROUNDING_UNITS as readonly number[]).includes(input.roundingUnit)) throw inputError('roundingUnit must be 1, 100 or 1000');
  if (input.makePrimary && !APPROVERS.has(actor.role)) {
    throw new BudgetVersionError('BUDGET_VERSION_FORBIDDEN', 'Only an owner or admin can make a budget version primary');
  }
  const { source } = input;
  // copyVersion (a same-year 0% copy) and setPrimary lock every version of the year: take those now, with the source's.
  const wholeYear = input.makePrimary || (source.type === 'version' && source.upliftPct === 0 && !input.adjust);
  const sourceYear = await lockSeedVersions(companyId, source.type === 'version' ? source.versionId : null, wholeYear ? input.fiscalYear : null);
  const p = await plan(companyId, input, sourceYear);
  if (p.cells) assertSeedSize(p.cells.length);
  try {
    return await withSavepoint('budget_grid_seed', () => write(companyId, actor, input, p, name, kind));
  } catch (err) {
    // Two make-primary seeds in a year with no version yet share no row to queue on: the later one
    // waits on the other's new primary and then breaks the one-primary index. The savepoint has
    // already taken its version back and left the transaction usable, so this is a clean 409.
    const e = err as { code?: string; constraint?: string } | null;
    if (e?.code === '23505' && e.constraint === 'uq_budget_versions_one_primary') {
      throw new BudgetVersionError('BUDGET_VERSION_STATE',
        `Another version became primary for FY${input.fiscalYear} at the same time; reload and try again`);
    }
    return mapBudgetDbError(err);
  }
}
