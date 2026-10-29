/**
 * The rolling forecast (Budgets P4 spec §6): a reforecast with a `budget_rolling_forecasts` row is
 * re-rolled after each period close (`budgetRollQueue`, after commit) and on "Roll now".
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
 * A locked version is not rolled: last_error = 'version locked' is written OUTSIDE the savepoint
 * (which the refusal rolled back), so it persists, and nothing else changes. A month reopened
 * after a roll: its 'actual' cells become 'manual' (value kept) and a driver covering it recomputes.
 */
import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { auditBudgetWrite, holdYearRegistry, lockVersionForWrite, versionYear } from '../budgetVersionScope';
import { BudgetVersionError, budgetDbRefusal } from '../budgetVersionTypes';
import { inputError, isVersionToken, tokenSql } from '../gridErrors';
import { takeVersion } from '../versionTake';
import { budgetMonthKeysInWindow, monthKeyToDate } from '../../reports/budgetPeriodWindow';
import type { DriverWarning } from './driverTypes';
import { loadVersionModel } from './driverModel';
import { listDriverLines } from './driverRepository';
import {
  closedMonthsOf, describeUnplaced, planOver, readClosedActuals, reforecastYear, writePlannedCells, type UnplacedActualLine,
} from './reforecastInputs';
import { insertRollingRow } from './reforecastService';

/** 'auto' = the after-close roll (no token); Roll now carries the version token the client read. */
export type RollMode = 'auto' | { expectedUpdatedAt: string };

export interface RollOutcome {
  /** 'locked': skipped, last_error recorded; 'not_rolling': an auto roll found no rolling row. */
  status: 'rolled' | 'locked' | 'not_rolling';
  /** Cells written. */
  changed: number;
  closedMonths: string[];
  rolledThroughMonth: string | null;
  unplaced: UnplacedActualLine[];
  warnings: DriverWarning[];
  /** The version's token after the roll (null when not rolled). */
  updatedAt: string | null;
}

export interface RollingStatus {
  rolling: boolean;
  /** 'YYYY-MM' months. */
  rolledThroughMonth: string | null;
  latestClosedMonth: string | null;
  /** Closed months after rolledThroughMonth: closed since the last roll (a roll that did not run). */
  staleMonths: string[];
  lastRolledAt: string | null;
  lastError: string | null;
}

interface RollingRow { fiscalYear: number; rolledThrough: string | null; lastRolledAt: string | null; lastError: string | null }

const VERSION_LOCKED = 'version locked';

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

const versionToken = async (companyId: string, versionId: string): Promise<string> => String(((await sql`
  SELECT ${tokenSql()} AS token FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
`) as DbRow[])[0]?.token ?? '');

async function rollingRow(companyId: string, versionId: string): Promise<RollingRow | null> {
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

const skipped = (status: 'locked' | 'not_rolling'): RollOutcome =>
  ({ status, changed: 0, closedMonths: [], rolledThroughMonth: null, unplaced: [], warnings: [], updatedAt: null });

export async function rollVersion(companyId: string, userId: string, versionId: string, mode: RollMode): Promise<RollOutcome> {
  const id = versionId.toLowerCase();
  if (mode !== 'auto' && !isVersionToken(mode.expectedUpdatedAt)) {
    throw inputError('expectedUpdatedAt must be the updatedAt the version was read with');
  }
  await holdYearRegistry(companyId);
  const row = await rollingRow(companyId, id);
  if (!row) {
    if (mode === 'auto') return skipped('not_rolling');
    await versionYear(companyId, id); // another company's version: 404
    throw new BudgetVersionError('BUDGET_VERSION_STATE', 'This version is not a rolling forecast: turn its auto-roll on first');
  }
  try {
    return await withSavepoint('budget_roll', async () => {
      if (mode === 'auto') await lockVersionForWrite(companyId, id);
      else await takeVersion(companyId, id, mode.expectedUpdatedAt);
      const { year, months } = await reforecastYear(companyId, row.fiscalYear);
      const closed = await closedMonthsOf(companyId, year, months);
      const read = await readClosedActuals(companyId, year, closed);
      const model = await loadVersionModel(companyId, id, months, await listDriverLines(companyId, id));
      const { plan, headcountAsOf } = await planOver(companyId, model, id, closed, read);
      const changed = await writePlannedCells(companyId, id, userId, plan.cells);
      const through = closed.length > 0 ? closed[closed.length - 1]! : null;
      const unplaced = describeUnplaced(plan, read);
      const outcome = { status: 'rolled' as const, changed, closedMonths: closed, rolledThroughMonth: through, unplaced, warnings: plan.warnings };
      if (changed === 0) throw new NothingRolled(outcome);
      await markRolled(companyId, id, through);
      await auditBudgetWrite(companyId, userId, 'update', id, row.fiscalYear, {
        rolled: mode === 'auto' ? 'auto' : 'roll_now', closedMonths: closed.join(',') || 'none', cells: String(changed),
        unplaced: String(unplaced.length), headcountAsOf: headcountAsOf ?? 'none',
      });
      log.info('Rolled budget forecast', { companyId, versionId: id, mode: mode === 'auto' ? 'auto' : 'roll_now', changed, through }, 'accounting');
      return { ...outcome, updatedAt: await versionToken(companyId, id) } satisfies RollOutcome;
    });
  } catch (err) {
    if (err instanceof NothingRolled) {
      // The savepoint (the version lock's token bump included) is rolled back: only the rolling row moves.
      await markRolled(companyId, id, err.outcome.rolledThroughMonth);
      log.info('Rolled budget forecast: nothing changed', { companyId, versionId: id, mode: mode === 'auto' ? 'auto' : 'roll_now' }, 'accounting');
      return { ...err.outcome, updatedAt: await versionToken(companyId, id) };
    }
    const refusal = budgetDbRefusal(err) ?? err;
    if (!(refusal instanceof BudgetVersionError) || refusal.code !== 'BUDGET_VERSION_LOCKED') throw refusal;
    await sql`
      UPDATE budget_rolling_forecasts SET last_error = ${VERSION_LOCKED}
       WHERE company_id = ${companyId}::UUID AND version_id = ${id}::UUID
    `;
    log.warn('Budget roll skipped: the version is locked', { companyId, versionId: id, mode: mode === 'auto' ? 'auto' : 'roll_now' }, 'accounting');
    if (mode === 'auto') return skipped('locked');
    throw refusal;
  }
}

/** What the versions bar shows: "Rolled through <month> · N closed since". Another company's version is a 404. */
export async function rollingStatus(companyId: string, versionId: string): Promise<RollingStatus> {
  const id = versionId.toLowerCase();
  const year = await versionYear(companyId, id);
  const row = await rollingRow(companyId, id);
  const closed = await closedMonthsOf(companyId, year, budgetMonthKeysInWindow(year.startDate, year.endDate));
  const through = row?.rolledThrough ?? null;
  return {
    rolling: row !== null,
    rolledThroughMonth: through,
    latestClosedMonth: closed.length > 0 ? closed[closed.length - 1]! : null,
    staleMonths: row ? closed.filter((m) => through === null || m > through) : [],
    lastRolledAt: row?.lastRolledAt ?? null,
    lastError: row?.lastError ?? null,
  };
}

/**
 * Turns auto-roll on (a reforecast only; one per company and year) or off (the row deleted) for
 * the version, under its compare-and-set token, in one savepoint. Returns the new token.
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
        const kind = (await sql`SELECT kind FROM budget_versions WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
        if (kind[0]?.kind !== 'reforecast') throw new BudgetVersionError('BUDGET_VERSION_STATE', 'Only a reforecast can roll forward');
        await insertRollingRow(companyId, v.fiscalYear, id, userId);
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
