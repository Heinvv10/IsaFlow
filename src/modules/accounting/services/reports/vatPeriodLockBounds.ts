/**
 * What a VAT period lock may cover. A lock records a return that has been
 * FILED, so:
 *
 *   - it cannot end after today — nothing has been filed for days to come, and
 *     a lock reaching into the future would refuse postings nobody filed;
 *   - it cannot span more than twelve months — no SA VAT period does, and a
 *     typo'd year would otherwise freeze a decade of VAT postings;
 *   - it cannot overlap another ACTIVE lock — two filed returns claiming one day
 *     leave no single record of what was filed for it. Re-locking the EXACT
 *     active period is not an overlap: lockVatPeriod answers it idempotently.
 *     An unlocked lock is history and overlaps nothing.
 *
 * Checked inside lockVatPeriod under the exclusive VAT-lock key (so two
 * overlapping locks cannot both pass), and by the MCP tool before its dry run
 * returns, so the preview refuses what the live call refuses.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/** A lock or unlock the caller can fix. Pre-write; its message is safe to show. */
export class VatPeriodLockRefusal extends Error {
  readonly code = 'VAT_PERIOD_LOCK_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'VatPeriodLockRefusal';
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** `date` plus twelve calendar months, as YYYY-MM-DD. */
function plusTwelveMonths(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
}

export async function assertLockablePeriod(companyId: string, periodStart: string, periodEnd: string): Promise<void> {
  if (!isCalendarDate(periodStart) || !isCalendarDate(periodEnd)) {
    throw new VatPeriodLockRefusal('period_start and period_end must be real dates in YYYY-MM-DD format.');
  }
  if (periodEnd < periodStart) throw new VatPeriodLockRefusal('period_end must not be before period_start');
  // fmtDate, not toISOString: between 00:00 and 02:00 SAST the latter is yesterday.
  const today = fmtDate(new Date());
  if (periodEnd > today) {
    throw new VatPeriodLockRefusal(
      `The period ends ${periodEnd}, after today (${today}). A lock records a VAT201 that has been filed; `
      + 'lock the period once its return is filed.',
    );
  }
  if (periodEnd >= plusTwelveMonths(periodStart)) {
    throw new VatPeriodLockRefusal(
      `${periodStart} to ${periodEnd} is more than 12 months. A lock covers one filed VAT period — `
      + 'lock each return separately.',
    );
  }
  const overlap = (await sql`
    SELECT period_start, period_end FROM vat_period_locks
    WHERE company_id = ${companyId}::UUID AND unlocked_at IS NULL
      AND period_start <= ${periodEnd}::DATE AND period_end >= ${periodStart}::DATE
      AND NOT (period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE)
    ORDER BY period_start
    LIMIT 1`) as DbRow[];
  if (overlap[0]) {
    throw new VatPeriodLockRefusal(
      `${periodStart} to ${periodEnd} overlaps the locked VAT period `
      + `${fmtDate(overlap[0].period_start as string)} to ${fmtDate(overlap[0].period_end as string)}. `
      + 'Two filed returns cannot cover the same day; unlock that period first if it was filed wrongly.',
    );
  }
}
