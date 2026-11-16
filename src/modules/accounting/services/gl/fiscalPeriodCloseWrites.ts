/**
 * The writers that change a fiscal period's status: close, lock, reopen and
 * close year. Re-exported by fiscalPeriodService, which every caller imports.
 *
 * Each one, inside the request transaction and under one bounded lock wait
 * (`withPeriodLockBudget`):
 *   1. locks the period row(s) `FOR NO KEY UPDATE`, in (fiscal_year,
 *      period_number, id) order, the order every period locker uses;
 *   2. re-reads the status from the locked row, so a concurrent reopen or close
 *      is seen, never overwritten;
 *   3. close and lock only: runs the readiness gate (periodCloseGate), which
 *      throws before anything is written;
 *   4. writes exactly the rows it judged.
 * Reopen is not gated: it takes the lock only so it waits for a close in flight.
 */

import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { scheduleAutoSnapshot } from '@/modules/accounting/services/audit/autoSnapshotQueue';
import { scheduleBudgetRoll } from '@/modules/accounting/services/budgets/drivers/budgetRollQueue';
import { isLockTimeoutError } from '@/lib/lockTimeout';
import type { FiscalPeriod } from '../../types/gl.types';
import { mapFiscalPeriodRow as mapRow } from './fiscalPeriodRow';
import { assertPeriodCloseReady, assertYearCloseReady, withPeriodLockBudget } from './periodCloseGate';
import { isCloseRefusal, PeriodNotCloseableError } from './periodCloseErrors';
import type { CloseCheckMemo, CloseReadiness } from './periodCloseReadinessService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const settled = (s: string) => s === 'closed' || s === 'locked'; // a NULL status maps to 'null': not settled

/** An answer for the caller (refusal, busy period), logged by whoever raised it, never as a fault here. */
function isExpected(err: unknown): boolean {
  return err instanceof PeriodNotCloseableError || isCloseRefusal(err) || isLockTimeoutError(err);
}

/** The period row, locked for the rest of the transaction. A miss is generic: no existence oracle. */
async function lockPeriodRow(companyId: string, id: string): Promise<FiscalPeriod> {
  if (!UUID_RE.test(id)) throw new PeriodNotCloseableError('Fiscal period not found');
  const rows = (await sql`
    SELECT * FROM fiscal_periods WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR NO KEY UPDATE
  `) as DbRow[];
  if (!rows[0]) throw new PeriodNotCloseableError('Fiscal period not found');
  return mapRow(rows[0]);
}

/** Status and order guards of a close, on the locked row. */
async function assertCloseable(companyId: string, period: FiscalPeriod): Promise<void> {
  if (period.status === 'locked') throw new PeriodNotCloseableError(`${period.periodName} is locked and cannot be closed`);
  if (period.status === 'closed') throw new PeriodNotCloseableError(`${period.periodName} is already closed`);
  const open = (await sql`
    SELECT period_name FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID AND fiscal_year = ${period.fiscalYear}
      AND period_number < ${period.periodNumber}
      AND status IS DISTINCT FROM 'closed' AND status IS DISTINCT FROM 'locked'
    ORDER BY period_number
  `) as DbRow[];
  if (open.length > 0) {
    throw new PeriodNotCloseableError(`${period.periodName} cannot be closed: prior periods are still open `
      + `(${open.map((r) => String(r.period_name)).join(', ')}). Close them first.`);
  }
}

/**
 * Everything a close decides, without the write: lock the row, the status and
 * order guards, the readiness gate. The MCP dry run calls this; the live close
 * calls it and writes. Throws PeriodNotCloseableError / PeriodCloseBlockedError.
 */
export async function judgePeriodClose(
  companyId: string, id: string, memo?: CloseCheckMemo,
): Promise<{ period: FiscalPeriod; readiness: CloseReadiness }> {
  return withPeriodLockBudget(async () => {
    const period = await lockPeriodRow(companyId, id);
    await assertCloseable(companyId, period);
    return { period, readiness: await assertPeriodCloseReady(companyId, id, memo) };
  });
}

/** Close one period; returns the closed period AND the readiness verdict judged under its lock. */
export async function closePeriodWithVerdict(
  companyId: string, id: string, userId: string, memo?: CloseCheckMemo,
): Promise<{ period: FiscalPeriod; readiness: CloseReadiness }> {
  await assertNotImpersonating(); // R-032: period controls are refused to a Login-as session
  try {
    return await withPeriodLockBudget(async () => {
      const { readiness } = await judgePeriodClose(companyId, id, memo);
      const rows = (await sql`
        UPDATE fiscal_periods
        SET status = 'closed', closed_by = ${userId}::UUID, closed_at = NOW()
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
        RETURNING *
      `) as DbRow[];
      const closed = mapRow(rows[0]!);
      scheduleAutoSnapshot('period_close', closed.endDate); // forensic step 4: after commit, never blocks the close
      scheduleBudgetRoll(companyId, closed.endDate); // budgets P4: re-roll the year's rolling forecast after commit
      return { period: closed, readiness };
    });
  } catch (err) {
    if (!isExpected(err)) log.error('Failed to close period', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function closePeriod(companyId: string, id: string, userId: string): Promise<FiscalPeriod> {
  return (await closePeriodWithVerdict(companyId, id, userId)).period;
}

/** Lock a closed period, after judging it again: it may have been closed before the gate, or changed since. */
export async function lockPeriod(companyId: string, id: string, memo?: CloseCheckMemo): Promise<FiscalPeriod> {
  await assertNotImpersonating(); // R-032: period controls are refused to a Login-as session
  try {
    return await withPeriodLockBudget(async () => {
      const period = await lockPeriodRow(companyId, id);
      if (period.status !== 'closed') throw new PeriodNotCloseableError('Period must be closed before locking');
      await assertPeriodCloseReady(companyId, id, memo, 'locked');
      const rows = (await sql`
        UPDATE fiscal_periods SET status = 'locked'
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'closed'
        RETURNING *
      `) as DbRow[];
      const locked = mapRow(rows[0]!);
      scheduleAutoSnapshot('period_close', locked.endDate);
      scheduleBudgetRoll(companyId, locked.endDate);
      return locked;
    });
  } catch (err) {
    if (!isExpected(err)) log.error('Failed to lock period', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function reopenPeriod(companyId: string, id: string): Promise<FiscalPeriod> {
  await assertNotImpersonating(); // R-032: period controls are refused to a Login-as session
  try {
    return await withPeriodLockBudget(async () => {
      const period = await lockPeriodRow(companyId, id);
      if (period.status === 'locked') throw new PeriodNotCloseableError('Cannot reopen a locked period');
      if (period.status === 'open') throw new PeriodNotCloseableError('Period is already open');
      const rows = (await sql`
        UPDATE fiscal_periods
        SET status = 'open', closed_by = NULL, closed_at = NULL
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
        RETURNING *
      `) as DbRow[];
      return mapRow(rows[0]!);
    });
  } catch (err) {
    if (!isExpected(err)) log.error('Failed to reopen period', { id, error: err }, 'accounting');
    throw err;
  }
}

/** Close every unsettled period of the year: all or nothing, like its one UPDATE. */
export async function closeYear(companyId: string, fiscalYear: number, userId: string): Promise<FiscalPeriod[]> {
  await assertNotImpersonating(); // R-032: period controls are refused to a Login-as session
  try {
    return await withPeriodLockBudget(async () => {
      const periods = ((await sql`
        SELECT * FROM fiscal_periods WHERE company_id = ${companyId}::UUID AND fiscal_year = ${fiscalYear}
        ORDER BY fiscal_year, period_number, id FOR NO KEY UPDATE
      `) as DbRow[]).map(mapRow);
      if (periods.length === 0) throw new PeriodNotCloseableError(`No periods found for fiscal year ${fiscalYear}`);

      const toClose = periods.filter((p) => !settled(p.status));
      if (toClose.length === 0) throw new PeriodNotCloseableError(`Fiscal year ${fiscalYear} is already closed`);
      // A blocked period refuses the year, naming every one; the company-wide check runs once.
      await assertYearCloseReady(companyId, fiscalYear, toClose, {});

      const rows = (await sql`
        UPDATE fiscal_periods
        SET status = 'closed', closed_by = ${userId}::UUID, closed_at = NOW()
        WHERE company_id = ${companyId}::UUID AND id = ANY(${toClose.map((p) => p.id)}::UUID[])
        RETURNING *
      `) as DbRow[];

      log.info('Fiscal year closed', { companyId, fiscalYear, updated: rows.length }, 'accounting');
      const closed = rows.map(mapRow);
      for (const p of closed) scheduleAutoSnapshot('year_close', p.endDate); // one snapshot, at the latest end date
      for (const p of closed) scheduleBudgetRoll(companyId, p.endDate); // one roll per fiscal year
      return closed;
    });
  } catch (err) {
    if (!isExpected(err)) log.error('Failed to close fiscal year', { fiscalYear, error: err }, 'accounting');
    throw err;
  }
}
