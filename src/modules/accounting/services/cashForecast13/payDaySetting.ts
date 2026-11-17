/**
 * The company's salary pay day (payroll_company_settings.salary_pay_rule / salary_pay_day, migration
 * 999i): day N of the month (1-31; beyond the month's length = its last day) or the last working day.
 * Not chosen (no row, or both columns NULL, as on a row 999a's pay-week settings created) reads as day 25
 * with `isDefault: true`. The write upserts the company's row, refuses a Login-as session first and writes
 * one audit row (entity_type 'payroll_company_settings') in the request transaction; a save that changes
 * nothing writes nothing. Choosing last_working_day keeps the stored day, so switching back restores it.
 * updated_by / updated_at are the table's stamp trigger's (999i), never written here.
 */
import { sql } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import type { DbRow } from '@/types/db';
import { logAuditOrThrow } from '../core/auditTrailService';
import type { PayDayInput } from './storeSchemas';
import { DEFAULT_PAY_DAY, type PayDayRule } from './storeTypes';

export interface PayDaySetting {
  payDay: PayDayRule;
  /** The stored day of the month (kept while the rule is last_working_day); 25 when none was chosen. */
  day: number;
  /** No pay day chosen yet: the defaults. */
  isDefault: boolean;
}

interface Stored { exists: boolean; rule: string | null; day: number | null }

const storedOf = (r: DbRow | undefined): Stored => ({
  exists: r !== undefined,
  rule: r?.salary_pay_rule == null ? null : String(r.salary_pay_rule),
  day: r?.salary_pay_day == null ? null : Number(r.salary_pay_day),
});

function toSetting(s: Stored): PayDaySetting {
  const day = s.day ?? DEFAULT_PAY_DAY;
  if (s.rule === 'last_working_day') return { payDay: { kind: 'last_working_day' }, day, isDefault: false };
  if (s.rule === 'day_of_month') return { payDay: { kind: 'day_of_month', day }, day, isDefault: false };
  return { payDay: { kind: 'day_of_month', day: DEFAULT_PAY_DAY }, day: DEFAULT_PAY_DAY, isDefault: true };
}

const labelOf = (s: PayDaySetting) =>
  s.isDefault ? `Not chosen (day ${DEFAULT_PAY_DAY})` : s.payDay.kind === 'last_working_day' ? 'Last working day' : `Day ${s.payDay.day}`;

const read = async (companyId: string, lock: boolean): Promise<Stored> => storedOf(((lock
  ? await sql`SELECT salary_pay_rule, salary_pay_day FROM payroll_company_settings WHERE company_id = ${companyId}::UUID FOR UPDATE`
  : await sql`SELECT salary_pay_rule, salary_pay_day FROM payroll_company_settings WHERE company_id = ${companyId}::UUID`) as DbRow[])[0]);

export async function getPayDay(companyId: string): Promise<PayDaySetting> {
  return toSetting(await read(companyId, false));
}

export async function setPayDay(companyId: string, userId: string, input: PayDayInput): Promise<PayDaySetting> {
  await assertNotImpersonating();
  const prior = await read(companyId, true);
  const before = toSetting(prior);
  const day = input.kind === 'day_of_month' ? input.day : prior.day;
  if (prior.rule === input.kind && prior.day === day) return before;
  const rows = (await sql`
    INSERT INTO payroll_company_settings (company_id, salary_pay_rule, salary_pay_day)
    VALUES (${companyId}::UUID, ${input.kind}, ${day})
    ON CONFLICT (company_id) DO UPDATE
       SET salary_pay_rule = EXCLUDED.salary_pay_rule, salary_pay_day = EXCLUDED.salary_pay_day
    RETURNING salary_pay_rule, salary_pay_day
  `) as DbRow[];
  const after = toSetting(storedOf(rows[0]));
  await logAuditOrThrow({
    companyId, userId, action: prior.exists ? 'update' : 'create', entityType: 'payroll_company_settings', entityId: companyId,
    entityRef: 'Salary pay day',
    changes: {
      fields: [{ field: 'salary_pay_day', label: 'Salary pay day', old: labelOf(before), new: labelOf(after) }],
      metadata: { area: 'cash_forecast_13' },
    },
  });
  return after;
}
