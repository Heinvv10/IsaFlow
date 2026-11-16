/**
 * The company's salary pay day (payroll_company_settings.salary_pay_rule / salary_pay_day, migration
 * 999i): day N of the month (1-31; beyond the month's length = its last day) or the last working day.
 * No row = day 25. The write upserts the company's row, refuses a Login-as session first and writes one
 * audit row (entity_type 'payroll_company_settings') in the request transaction. Choosing
 * last_working_day keeps the stored day, so switching back restores it.
 *
 * updated_by / updated_at are written here, as migration 999a's contract for this table has it (no stamp
 * trigger there); the audit row is the record of who changed the pay day.
 */
import { sql } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import type { DbRow } from '@/types/db';
import { logAuditOrThrow } from '../core/auditTrailService';
import type { PayDayInput } from './storeSchemas';
import { DEFAULT_PAY_DAY, type PayDayRule } from './storeTypes';

export interface PayDaySetting {
  payDay: PayDayRule;
  /** The stored day of the month, kept while the rule is last_working_day. */
  day: number;
  /** No settings row yet: the defaults. */
  isDefault: boolean;
}

function toSetting(r: DbRow | undefined): PayDaySetting {
  if (!r) return { payDay: { kind: 'day_of_month', day: DEFAULT_PAY_DAY }, day: DEFAULT_PAY_DAY, isDefault: true };
  const day = Number(r.salary_pay_day);
  const payDay: PayDayRule = r.salary_pay_rule === 'last_working_day' ? { kind: 'last_working_day' } : { kind: 'day_of_month', day };
  return { payDay, day, isDefault: false };
}

const labelOf = (p: PayDayRule) => (p.kind === 'last_working_day' ? 'Last working day' : `Day ${p.day}`);

export async function getPayDay(companyId: string): Promise<PayDaySetting> {
  const rows = (await sql`
    SELECT salary_pay_rule, salary_pay_day FROM payroll_company_settings WHERE company_id = ${companyId}::UUID
  `) as DbRow[];
  return toSetting(rows[0]);
}

export async function setPayDay(companyId: string, userId: string, input: PayDayInput): Promise<PayDaySetting> {
  await assertNotImpersonating();
  const prior = (await sql`
    SELECT salary_pay_rule, salary_pay_day FROM payroll_company_settings WHERE company_id = ${companyId}::UUID FOR UPDATE
  `) as DbRow[];
  const before = toSetting(prior[0]);
  const day = input.kind === 'day_of_month' ? input.day : before.day;
  const rows = (await sql`
    INSERT INTO payroll_company_settings (company_id, salary_pay_rule, salary_pay_day, updated_by)
    VALUES (${companyId}::UUID, ${input.kind}, ${day}, ${userId})
    ON CONFLICT (company_id) DO UPDATE
       SET salary_pay_rule = EXCLUDED.salary_pay_rule, salary_pay_day = EXCLUDED.salary_pay_day,
           updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING salary_pay_rule, salary_pay_day
  `) as DbRow[];
  const after = toSetting(rows[0]);
  await logAuditOrThrow({
    companyId, userId, action: before.isDefault ? 'create' : 'update', entityType: 'payroll_company_settings', entityId: companyId,
    entityRef: 'Salary pay day',
    changes: {
      fields: [{ field: 'salary_pay_day', label: 'Salary pay day', old: labelOf(before.payDay), new: labelOf(after.payDay) }],
      metadata: { area: 'cash_forecast_13' },
    },
  });
  return after;
}
