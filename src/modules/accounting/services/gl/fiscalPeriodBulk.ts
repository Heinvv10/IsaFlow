/**
 * Bulk Close / Lock / Reopen of fiscal periods (fiscal-periods-action).
 *
 * ── ORDER ───────────────────────────────────────────────────────────────────
 * The ids arrive in click order. Every one is locked UP FRONT, in one
 * statement, in (fiscal_year, period_number, id) order — the order Close Year,
 * the year-end close and a change of year end lock in — and processed in that
 * order. Two requests over overlapping periods then wait for each other rather
 * than deadlock, and an earlier period is closed before the later one asks
 * whether its prior periods are open.
 *
 * ── PARTIAL SUCCESS, NEVER FALSE SUCCESS ────────────────────────────────────
 * Each period runs in its own savepoint. A REFUSAL (the readiness gate, a
 * status or order guard) is that period's `ok: false` row and the rest go on.
 * Anything else — a lock wait that ran out, a deadlock, a driver error, a
 * Login-as session — is rethrown: the route answers 503 / 403 / 500 and the
 * request rolls back whole, so no response can report `ok: true` for a write
 * the database did not keep.
 */

import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { closePeriodWithVerdict, lockPeriod, reopenPeriod } from './fiscalPeriodCloseWrites';
import { withPeriodLockBudget } from './periodCloseGate';
import {
  isCloseRefusal, PERIOD_CLOSE_NOT_READY, PeriodNotCloseableError, type BlockedPeriod,
} from './periodCloseErrors';
import type { CloseCheckMemo } from './periodCloseReadinessService';

export type BulkPeriodAction = 'bulk_close' | 'bulk_lock' | 'bulk_reopen';

export interface BulkPeriodRow {
  id: string;
  ok: boolean;
  error?: string;
  /** PERIOD_CLOSE_NOT_READY when the readiness gate refused it; `periods` then names the failing checks. */
  code?: string;
  periods?: BlockedPeriod[];
}

export interface BulkPeriodResult {
  results: BulkPeriodRow[];
  okCount: number;
  total: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = 'Fiscal period not found';

async function runOne(
  action: BulkPeriodAction, companyId: string, id: string, userId: string, memo: CloseCheckMemo,
): Promise<void> {
  if (action === 'bulk_close') await closePeriodWithVerdict(companyId, id, userId, memo);
  else if (action === 'bulk_lock') await lockPeriod(companyId, id, memo);
  else await reopenPeriod(companyId, id);
}

/** The refusal row for an error that is an answer; null for one that must fail the request. */
function refusalRow(id: string, err: unknown): BulkPeriodRow | null {
  if (isCloseRefusal(err)) return { id, ok: false, error: err.message, code: PERIOD_CLOSE_NOT_READY, periods: err.periods };
  if (err instanceof PeriodNotCloseableError) return { id, ok: false, error: err.message };
  return null;
}

export async function runBulkPeriodAction(
  companyId: string, action: BulkPeriodAction, ids: readonly string[], userId: string,
): Promise<BulkPeriodResult> {
  return withPeriodLockBudget(async () => {
    const valid = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
    const locked = valid.length === 0 ? [] : (await sql`
      SELECT id FROM fiscal_periods
      WHERE company_id = ${companyId}::UUID AND id = ANY(${valid}::UUID[])
      ORDER BY fiscal_year, period_number, id
      FOR NO KEY UPDATE
    `) as DbRow[];

    const memo: CloseCheckMemo = {}; // the company-wide readiness check runs once for the whole request
    const byId = new Map<string, BulkPeriodRow>();
    for (const [i, row] of locked.entries()) {
      const id = String(row.id);
      try {
        await withSavepoint(`fp_bulk_${i}`, () => runOne(action, companyId, id, userId, memo));
        byId.set(id, { id, ok: true });
      } catch (err) {
        const refused = refusalRow(id, err);
        if (!refused) throw err;
        byId.set(id, refused);
      }
    }

    const results = ids.map((id) => byId.get(id) ?? { id, ok: false, error: NOT_FOUND });
    const okCount = results.filter((r) => r.ok).length;
    log.info('Bulk fiscal period action', { action, total: ids.length, ok: okCount }, 'accounting');
    return { results, okCount, total: ids.length };
  });
}
