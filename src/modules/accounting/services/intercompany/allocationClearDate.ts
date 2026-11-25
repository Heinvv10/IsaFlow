/**
 * The posting date of a receiver's clearing (P4-D, plan (i).4): the PERSON chooses it, never the payer. It must be on or after the payment
 * date, not after today (Johannesburg), in an OPEN financial period and outside an active VAT period lock. The preview proposes the payment
 * date when that holds, else the first date after it that does (never after today), else none.
 */
import { sql } from '@/lib/neon';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { findActiveVatLock } from '../gl/journalVatLockGuard';

type Row = Record<string, unknown>;

/** Today in Johannesburg, as the ledger's day. */
export async function todaySast(): Promise<string> {
  const rows = (await sql`SELECT to_char((now() AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') AS d`) as Row[];
  return String(rows[0]!.d);
}

/** Why the date cannot take the clearing (period first, then the VAT lock), or null when it can. Reads only, before anything is written. */
export async function postingDateRefusal(companyId: string, date: string): Promise<'no_period' | 'period_locked' | 'vat_locked' | null> {
  const period = await getPeriodStatusForDate(companyId, date);
  if (period === 'no_period') return 'no_period';
  if (period !== 'open') return 'period_locked';
  if (await findActiveVatLock(companyId, date)) return 'vat_locked';
  return null;
}

const nextDay = (d: string): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

/**
 * The date the preview proposes: the payment date when it can take the clearing, else the first date after it that can (an open period's
 * first day, or the day after an active VAT lock ends), never after today; null when there is none. At most 48 steps.
 */
export async function defaultPostingDate(companyId: string, paymentDate: string, today: string): Promise<string | null> {
  let candidate = paymentDate;
  for (let step = 0; step < 48; step += 1) {
    if (candidate > today) return null;
    if (await getPeriodStatusForDate(companyId, candidate) === 'open') {
      const lock = await findActiveVatLock(companyId, candidate);
      if (!lock) return candidate;
      candidate = nextDay(lock.periodEnd);
      continue;
    }
    const next = (await sql`
      SELECT to_char(min(start_date), 'YYYY-MM-DD') AS d FROM fiscal_periods
       WHERE company_id = ${companyId}::UUID AND status = 'open' AND start_date > ${candidate}::DATE
    `) as Row[];
    if (!next[0]?.d) return null;
    candidate = String(next[0].d);
  }
  return null;
}
