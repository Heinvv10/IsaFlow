/**
 * The company's pay week (wave 6 FQd; grill F17; Hein ruling §0a.13), stored in payroll_company_settings (999a).
 * No row means the defaults (Monday-Sunday, paid Friday, no fortnight anchor).
 *
 * THE LOCK. A final (payRunFinalSql) regular weekly or fortnightly run paid in this tax year or later fixes the week:
 *   - the start day and the pay day, once any such weekly or fortnightly run is final;
 *   - the fortnight anchor, once a fortnightly one is (a first anchor may still be set beside final weekly runs).
 * A change to a fixed setting is 409 PAY_WEEK_LOCKED, judged under the company's payroll-approval lock (the one
 * approvePayrollRun takes) before any write, so no run is approved between the check and the write.
 * "This tax year" is the SA tax year (1 March - end February) of today in Johannesburg.
 *
 * Each change writes one audit_log `update` row (one field entry per setting that moved); an unchanged value writes
 * nothing. updated_by / updated_at are the table's stamp trigger's, never written here.
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollForComponentChange } from './payrollCompanyLock';
import { payRunFinalSql } from './payRunFinalSql';
import { dateColumnOf } from './payrollFrequency';
import { DEFAULT_PAY_WEEK, dayName, type PayWeekSettings } from './payrollPayWeek';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export interface PayWeekState extends PayWeekSettings {
  /** Fixed for the tax year: the start day and pay day (a final weekly or fortnightly run), the anchor (a final fortnightly run). */
  locked: { week: boolean; anchor: boolean };
}

export class PayWeekLockedError extends Error {
  readonly code = 'PAY_WEEK_LOCKED';
  constructor(what: string) {
    super(`The ${what} cannot change this tax year: a weekly or fortnightly run paid on it is already approved. Change it from 1 March.`);
    this.name = 'PayWeekLockedError';
  }
}

/** Today in Johannesburg, 'YYYY-MM-DD'. */
export const todaySast = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());

/** 1 March of the SA tax year that holds `day` ('YYYY-MM-DD'). */
export function taxYearStartOf(day: string): string {
  const y = Number(day.slice(0, 4));
  return Number(day.slice(5, 7)) >= 3 ? `${y}-03-01` : `${y - 1}-03-01`;
}

const settingsOf = (r: DbRow | undefined): PayWeekSettings => (r ? {
  payWeekStartDow: Number(r.pay_week_start_dow), payWeekday: Number(r.pay_weekday), fortnightAnchor: dateColumnOf(r.fortnight_anchor),
} : { ...DEFAULT_PAY_WEEK });

async function lockedFor(db: TxSql, companyId: string, today: string): Promise<PayWeekState['locked']> {
  const rows = (await db`
    SELECT bool_or(true) AS week, bool_or(h.pay_frequency = 'fortnightly') AS anchor
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::uuid AND h.run_kind = 'regular' AND h.pay_frequency IN ('weekly', 'fortnightly')
       AND ${sql.unsafe(payRunFinalSql('h'))}
       AND COALESCE(h.run_date::date, h.period_end) >= ${taxYearStartOf(today)}::date
  `) as DbRow[];
  return { week: rows[0]?.week === true, anchor: rows[0]?.anchor === true };
}

/** The company's pay week (the defaults when it has no settings row). */
export async function readPayWeekSettings(companyId: string, db: TxSql = sql): Promise<PayWeekSettings> {
  const rows = (await db`
    SELECT pay_week_start_dow, pay_weekday, fortnight_anchor FROM payroll_company_settings WHERE company_id = ${companyId}::uuid
  `) as DbRow[];
  return settingsOf(rows[0]);
}

export async function readPayWeekState(companyId: string, today = todaySast()): Promise<PayWeekState> {
  return { ...(await readPayWeekSettings(companyId)), locked: await lockedFor(sql, companyId, today) };
}

/** Store `next` (already judged by judgePayWeekSettings). Throws PayWeekLockedError before any write. */
export async function setPayWeekSettings(
  companyId: string, next: PayWeekSettings, actor: EmployeeEmailActor, today = todaySast(),
): Promise<PayWeekState> {
  await withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    const before = settingsOf(((await tx`
      SELECT pay_week_start_dow, pay_weekday, fortnight_anchor FROM payroll_company_settings
       WHERE company_id = ${companyId}::uuid FOR UPDATE
    `) as DbRow[])[0]);
    const moved = ([
      ['payWeekStartDow', 'pay_week_start_dow', 'Pay week starts'],
      ['payWeekday', 'pay_weekday', 'Pay day'],
      ['fortnightAnchor', 'fortnight_anchor', 'Fortnight starts'],
    ] as const).filter(([k]) => before[k] !== next[k]);
    if (moved.length === 0) return;
    const locked = await lockedFor(tx, companyId, today);
    if (locked.week && moved.some(([k]) => k !== 'fortnightAnchor')) throw new PayWeekLockedError('pay week start day and pay day');
    if (locked.anchor && moved.some(([k]) => k === 'fortnightAnchor')) throw new PayWeekLockedError('fortnight start');
    await tx`
      INSERT INTO payroll_company_settings (company_id, pay_week_start_dow, pay_weekday, fortnight_anchor)
      VALUES (${companyId}::uuid, ${next.payWeekStartDow}, ${next.payWeekday}, ${next.fortnightAnchor}::date)
      ON CONFLICT (company_id) DO UPDATE SET pay_week_start_dow = EXCLUDED.pay_week_start_dow,
        pay_weekday = EXCLUDED.pay_weekday, fortnight_anchor = EXCLUDED.fortnight_anchor
    `;
    const shown = (k: keyof PayWeekSettings, s: PayWeekSettings): string | null =>
      k === 'fortnightAnchor' ? s.fortnightAnchor : dayName(s[k]);
    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_company_settings',
      entityId: companyId,
      changes: { fields: moved.map(([k, field, label]) => ({ field, old: shown(k, before), new: shown(k, next), label })) },
      ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
    });
  });
  return readPayWeekState(companyId, today);
}
