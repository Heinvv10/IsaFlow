/**
 * The rolling forecast (Budgets P4 spec §6): a reforecast with a `budget_rolling_forecasts` row is
 * re-rolled after each period close (`budgetRollQueue`, after commit) and on "Roll now". Roll now
 * also refreshes a reforecast that does NOT roll (a manual refresh: the same path and CAS, no
 * rolling row, so nothing is stamped); any other kind of version is a 409.
 *
 * A roll: holdYearRegistry → the rolling row → ONE savepoint: the version lock (auto: P1's
 * `lockVersionForWrite`, no token; Roll now: the grid's compare-and-set `takeVersion`, 409 STALE /
 * LOCKED) → `planReforecast` over ALL closed months of the year with the version's OWN cells,
 * drivers and hires as the source (headcount refreshed: nothing frozen; the audit row records
 * headcountAsOf) → only the cells whose amount or source differ written → the
 * row's rolled_through_month / last_rolled_at, last_error cleared → an audit row.
 * Re-rolling unchanged books writes no cell: the output is a function of committed state. A roll
 * that changes NO cell rolls its savepoint back (gridSave's NothingChanged), so the version's token
 * bump goes with it and no open grid turns stale; only the rolling row is then updated, outside it.
 *
 * A locked version is not rolled, nor a PRIMARY one (ruling 2026-10-29: a silent rewrite would move
 * what BvA compares against; auto-roll cannot be turned on for a primary, and a version made
 * primary since is skipped). last_error ('version locked' / 'version is primary') is written
 * OUTSIDE the savepoint (which the refusal rolled back, the token bump with it), so it persists,
 * and nothing else changes; Roll now then answers 409. An approved non-primary version rolls
 * (audited; decision 2). A month reopened after a roll: its 'actual' cells become 'manual' (value
 * kept) and a driver covering it recomputes. The status the versions bar reads is rollingStatus.ts.
 */
import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { auditBudgetWrite, holdYearRegistry, lockVersionForWrite } from '../budgetVersionScope';
import { BudgetVersionError, budgetDbRefusal } from '../budgetVersionTypes';
import { inputError, isVersionToken, tokenSql } from '../gridErrors';
import { takeVersion } from '../versionTake';
import { monthKeyToDate } from '../../reports/budgetPeriodWindow';
import { loadVersionModel } from './driverModel';
import type { RecomputeWarning } from './driverRecomputeService';
import { listDriverLines } from './driverRepository';
import {
  closedMonthsOf, describeUnplaced, planOver, readClosedActuals, reforecastYear, unplacedSummary, writePlannedCells,
  type UnplacedActualLine,
} from './reforecastInputs';
import { insertRollingRow } from './reforecastService';

/** 'auto' = the after-close roll (no token); Roll now carries the version token the client read. */
export type RollMode = 'auto' | { expectedUpdatedAt: string };

export interface RollOutcome {
  /** 'locked' / 'primary': skipped, last_error recorded; 'not_rolling': an auto roll found no rolling row. */
  status: 'rolled' | 'locked' | 'primary' | 'not_rolling';
  /** Cells written. */
  changed: number;
  closedMonths: string[];
  rolledThroughMonth: string | null;
  unplaced: UnplacedActualLine[];
  warnings: RecomputeWarning[];
  /** When payroll was read for per_head drivers (a roll refreshes headcount); null when none needed it or not rolled. */
  headcountAsOf: string | null;
  /** The version's token after the roll (null when not rolled). */
  updatedAt: string | null;
}

export interface RollingRow { fiscalYear: number; rolledThrough: string | null; lastRolledAt: string | null; lastError: string | null }

const VERSION_LOCKED = 'version locked';
const VERSION_PRIMARY = 'version is primary';

/** Thrown out of the roll's savepoint for a primary version: nothing it did (the token bump included) stands. */
class PrimarySkipped extends Error {
  constructor() {
    super(VERSION_PRIMARY);
  }
}

const isPrimary = async (companyId: string, versionId: string): Promise<boolean> => Boolean(((await sql`
  SELECT is_primary FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
`) as DbRow[])[0]?.is_primary);

/** Thrown out of the roll's savepoint when no cell changed: the savepoint (and its token bump) is rolled back. */
class NothingRolled extends Error {
  constructor(readonly outcome: Omit<RollOutcome, 'updatedAt'>) {
    super('nothing to roll');
  }
}

async function markRolled(companyId: string, versionId: string, through: string | null): Promise<void> {
  await sql`
    UPDATE budget_rolling_forecasts
       SET rolled_through_month = ${through === null ? null : monthKeyToDate(through)}::DATE, last_rolled_at = now(), last_error = NULL
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
  `;
}

/** A verified token in P1's form (UTC ISO, microseconds), whichever accepted form the client sent. */
const canonicalToken = async (token: string): Promise<string> => String(((await sql`
  SELECT to_char(${token}::TIMESTAMPTZ AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS token
`) as DbRow[])[0]?.token ?? token);

const versionToken = async (companyId: string, versionId: string): Promise<string> => String(((await sql`
  SELECT ${tokenSql()} AS token FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
`) as DbRow[])[0]?.token ?? '');

export async function rollingRow(companyId: string, versionId: string): Promise<RollingRow | null> {
  const rows = (await sql`
    SELECT fiscal_year, to_char(rolled_through_month, 'YYYY-MM') AS through, last_error,
           to_char(last_rolled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS rolled_at
      FROM budget_rolling_forecasts WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return { fiscalYear: Number(r.fiscal_year), rolledThrough: text(r.through), lastRolledAt: text(r.rolled_at), lastError: text(r.last_error) };
}

const skipped = (status: 'locked' | 'primary' | 'not_rolling'): RollOutcome =>
  ({ status, changed: 0, closedMonths: [], rolledThroughMonth: null, unplaced: [], warnings: [], headcountAsOf: null, updatedAt: null });

export async function rollVersion(companyId: string, userId: string, versionId: string, mode: RollMode): Promise<RollOutcome> {
  const id = versionId.toLowerCase();
  if (mode !== 'auto' && !isVersionToken(mode.expectedUpdatedAt)) {
    throw inputError('expectedUpdatedAt must be the updatedAt the version was read with');
  }
  await holdYearRegistry(companyId);
  const row = await rollingRow(companyId, id);
  let fiscalYear = row?.fiscalYear ?? null;
  if (fiscalYear === null) {
    if (mode === 'auto') return skipped('not_rolling');
    const v = (await sql`SELECT kind, fiscal_year FROM budget_versions WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    if (!v[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
    if (v[0].kind !== 'reforecast') throw new BudgetVersionError('BUDGET_VERSION_STATE', 'Only a reforecast can be refreshed from actuals');
    fiscalYear = Number(v[0].fiscal_year);
  }
  const fy = fiscalYear;
  try {
    return await withSavepoint('budget_roll', async () => {
      if (mode === 'auto') await lockVersionForWrite(companyId, id);
      else await takeVersion(companyId, id, mode.expectedUpdatedAt);
      // Read under the version lock: setPrimary locks the year's versions first, so it cannot slip in.
      if (await isPrimary(companyId, id)) throw new PrimarySkipped();
      const { year, months } = await reforecastYear(companyId, fy);
      const closed = await closedMonthsOf(companyId, year, months);
      const read = await readClosedActuals(companyId, year, closed);
      const model = await loadVersionModel(companyId, id, months, await listDriverLines(companyId, id));
      const { plan, headcountAsOf, warnings } = await planOver(companyId, model, id, closed, read);
      const changed = await writePlannedCells(companyId, id, userId, plan.cells);
      const through = closed.length > 0 ? closed[closed.length - 1]! : null;
      const unplaced = describeUnplaced(plan, read);
      const outcome = { status: 'rolled' as const, changed, closedMonths: closed, rolledThroughMonth: through, unplaced, warnings, headcountAsOf };
      if (changed === 0) throw new NothingRolled(outcome);
      await markRolled(companyId, id, through);
      await auditBudgetWrite(companyId, userId, 'update', id, fy, {
        rolled: mode === 'auto' ? 'auto' : 'roll_now', closedMonths: closed.join(',') || 'none', cells: String(changed),
        unplaced: unplacedSummary(unplaced), headcountAsOf: headcountAsOf ?? 'none',
      });
      log.info('Rolled budget forecast', { companyId, versionId: id, mode: mode === 'auto' ? 'auto' : 'roll_now', changed, through }, 'accounting');
      return { ...outcome, updatedAt: await versionToken(companyId, id) } satisfies RollOutcome;
    });
  } catch (err) {
    if (err instanceof NothingRolled) {
      // The savepoint (the version lock's token bump included) is rolled back: only the rolling row moves.
      await markRolled(companyId, id, err.outcome.rolledThroughMonth);
      log.info('Rolled budget forecast: nothing changed', { companyId, versionId: id, mode: mode === 'auto' ? 'auto' : 'roll_now' }, 'accounting');
      // Roll now: the client's token, which the CAS proved current (the bump was rolled back), in P1's form.
      return { ...err.outcome, updatedAt: mode === 'auto' ? await versionToken(companyId, id) : await canonicalToken(mode.expectedUpdatedAt) };
    }
    const refusal = budgetDbRefusal(err) ?? err;
    const primary = refusal instanceof PrimarySkipped;
    if (!primary && (!(refusal instanceof BudgetVersionError) || refusal.code !== 'BUDGET_VERSION_LOCKED')) throw refusal;
    await sql`
      UPDATE budget_rolling_forecasts SET last_error = ${primary ? VERSION_PRIMARY : VERSION_LOCKED}
       WHERE company_id = ${companyId}::UUID AND version_id = ${id}::UUID
    `;
    log.warn(`Budget roll skipped: ${primary ? VERSION_PRIMARY : VERSION_LOCKED}`, { companyId, versionId: id, mode: mode === 'auto' ? 'auto' : 'roll_now' }, 'accounting');
    if (mode === 'auto') return skipped(primary ? 'primary' : 'locked');
    throw primary
      ? new BudgetVersionError('BUDGET_VERSION_STATE',
        'This is the primary budget; refreshing it would change Budget vs Actual. Make another version primary first, or copy it')
      : refusal;
  }
}

/**
 * Turns auto-roll on (a non-primary reforecast only; one per company and year) or off (the row
 * deleted) for the version, under its compare-and-set token, in one savepoint. Returns the new
 * token. On stamps NOTHING (ruling 2026-10-29): an 'actual' cell is no proof its actual is current
 * (a copied reforecast; a reopen and re-close while not rolling), so every closed month reads stale
 * until a roll (Roll now, or the next close). Only a create with rolling:true stamps: it rolled.
 */
export async function setRolling(
  companyId: string, userId: string, versionId: string, rolling: boolean, expectedUpdatedAt: string,
): Promise<{ rolling: boolean; changed: boolean; updatedAt: string }> {
  const id = versionId.toLowerCase();
  if (!isVersionToken(expectedUpdatedAt)) throw inputError('expectedUpdatedAt must be the updatedAt the version was read with');
  await holdYearRegistry(companyId);
  try {
    return await withSavepoint('budget_rolling_toggle', async () => {
      const v = await takeVersion(companyId, id, expectedUpdatedAt);
      const had = (await rollingRow(companyId, id)) !== null;
      if (rolling && !had) {
        const kind = (await sql`SELECT kind, is_primary FROM budget_versions WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
        if (kind[0]?.kind !== 'reforecast') throw new BudgetVersionError('BUDGET_VERSION_STATE', 'Only a reforecast can roll forward');
        if (kind[0]?.is_primary) {
          throw new BudgetVersionError('BUDGET_VERSION_STATE',
            'The primary budget cannot roll forward: a roll would rewrite what the reports compare against. Make another version primary first');
        }
        await insertRollingRow(companyId, v.fiscalYear, id, userId, null);
      }
      if (!rolling && had) {
        await sql`DELETE FROM budget_rolling_forecasts WHERE company_id = ${companyId}::UUID AND version_id = ${id}::UUID`;
      }
      const changed = rolling !== had;
      if (changed) await auditBudgetWrite(companyId, userId, 'update', id, v.fiscalYear, { rolling: String(rolling) });
      return { rolling, changed, updatedAt: v.updatedAt };
    });
  } catch (err) {
    throw budgetDbRefusal(err) ?? err;
  }
}
