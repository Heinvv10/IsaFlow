/**
 * Budget controls: the company's settings row and the alert threshold overrides (migration 954;
 * budgets P5 spec §2, §4, decision 9). Read by the controls page and the overspend evaluator;
 * written by owners and admins through `/api/accounting/budgets/controls` (the route checks the
 * role; RLS and 954's column grants hold the tenant and the stamps).
 *
 * - No settings row = the defaults: policy 'warn', email OFF, thresholds 80/100/120 (954's column
 *   defaults; `DEFAULT_CONTROL_SETTINGS` is the same for a company that never saved).
 * - Thresholds: 1-5 whole percentages in 1-999, stored sorted ascending without duplicates.
 * - An override names an EXPENSE account of the company and at most one dimension (the slice).
 * - The email flag can only be switched ON (false → true) when this server allows budget alert email
 *   at all (env BUDGET_ALERT_EMAIL_ENABLED=1): enabling it is Hein's act (decision 9). A flag already
 *   on may be sent unchanged, and switching it off is always allowed.
 * Every change writes one `audit_log` row (entity `budget`, entity id = the company).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { DEFAULT_THRESHOLDS, normaliseThresholds, type ThresholdOverride } from './overspendAlertsCore';

export type CheckPolicy = 'off' | 'warn' | 'block';
export const CHECK_POLICIES: readonly CheckPolicy[] = ['off', 'warn', 'block'];

export interface ControlSettings {
  checkPolicy: CheckPolicy;
  alertEmailEnabled: boolean;
  defaultThresholds: number[];
  /** ISO; null when the company never saved (the defaults apply). */
  updatedAt: string | null;
}

/** The company's settings when it has no row (954's column defaults). Email is OFF. */
export const DEFAULT_CONTROL_SETTINGS: Readonly<Omit<ControlSettings, 'updatedAt'>> = {
  checkPolicy: 'warn', alertEmailEnabled: false, defaultThresholds: [...DEFAULT_THRESHOLDS],
};

/** Budget alert email may leave this server only with BUDGET_ALERT_EMAIL_ENABLED=1 (the kill switch). */
export function alertEmailAllowedOnServer(): boolean {
  return process.env.BUDGET_ALERT_EMAIL_ENABLED === '1';
}

/** A refusal the controls route answers with its status. */
export class BudgetControlsError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'BudgetControlsError';
  }
}

export interface OverrideRow extends ThresholdOverride {
  id: string;
  accountCode: string;
  accountName: string;
  /** The slice's centre or unit, 'CODE Name'; null for the whole account. */
  sliceName: string | null;
  thresholds: number[];
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : String(v ?? '').replace(/[{}]/g, '').split(',').filter(Boolean).map(Number));
const text = (v: unknown): string | null => (v == null ? null : String(v));

export async function readControlSettings(companyId: string): Promise<ControlSettings> {
  const rows = (await sql`
    SELECT check_policy, alert_email_enabled, default_thresholds::TEXT AS default_thresholds, updated_at
      FROM budget_control_settings WHERE company_id = ${companyId}::UUID
  `) as DbRow[];
  const r = rows[0];
  if (!r) return { ...DEFAULT_CONTROL_SETTINGS, defaultThresholds: [...DEFAULT_CONTROL_SETTINGS.defaultThresholds], updatedAt: null };
  return {
    checkPolicy: String(r.check_policy) as CheckPolicy,
    alertEmailEnabled: r.alert_email_enabled === true,
    defaultThresholds: normaliseThresholds(nums(r.default_thresholds)),
    updatedAt: iso(r.updated_at),
  };
}

const LABELS = { checkPolicy: 'Budget check policy', alertEmailEnabled: 'Alert email', defaultThresholds: 'Default alert thresholds' } as const;

export interface SettingsPatch {
  checkPolicy?: CheckPolicy;
  alertEmailEnabled?: boolean;
  defaultThresholds?: number[];
}

/** Saves the fields given (the rest keep their stored or default values); one audit row naming what changed. */
export async function saveControlSettings(companyId: string, userId: string, patch: SettingsPatch): Promise<ControlSettings> {
  const before = await readControlSettings(companyId);
  // Only switching it ON is refused while sending is off: a flag already on may be re-sent unchanged
  // (the form must still save the policy), and switching it off is always allowed.
  if (patch.alertEmailEnabled === true && !before.alertEmailEnabled && !alertEmailAllowedOnServer()) {
    throw new BudgetControlsError(409, 'Email sending is switched off on this server, so the budget alert email cannot be turned on.');
  }
  const next = {
    checkPolicy: patch.checkPolicy ?? before.checkPolicy,
    alertEmailEnabled: patch.alertEmailEnabled ?? before.alertEmailEnabled,
    defaultThresholds: patch.defaultThresholds ? normaliseThresholds(patch.defaultThresholds) : before.defaultThresholds,
  };
  await sql`
    INSERT INTO budget_control_settings (company_id, check_policy, alert_email_enabled, default_thresholds, updated_by)
    VALUES (${companyId}::UUID, ${next.checkPolicy}, ${next.alertEmailEnabled}, ${next.defaultThresholds}::NUMERIC[], ${userId})
    ON CONFLICT (company_id) DO UPDATE
       SET check_policy = EXCLUDED.check_policy, alert_email_enabled = EXCLUDED.alert_email_enabled,
           default_thresholds = EXCLUDED.default_thresholds, updated_by = EXCLUDED.updated_by
  `;
  const fields = (['checkPolicy', 'alertEmailEnabled', 'defaultThresholds'] as const)
    .filter((f) => String(before[f]) !== String(next[f]))
    .map((f) => ({ field: f, label: LABELS[f], old: String(before[f]), new: String(next[f]) }));
  if (fields.length > 0) {
    await logAuditOrThrow({
      companyId, userId, action: 'update', entityType: 'budget', entityId: companyId, entityRef: 'Budget controls',
      changes: { fields, metadata: { area: 'budget_controls' } },
    });
  }
  return readControlSettings(companyId);
}

/** The company's overrides, raw (for the evaluator). */
export async function readThresholdOverrides(companyId: string): Promise<ThresholdOverride[]> {
  const rows = (await sql`
    SELECT gl_account_id::TEXT AS gl_account_id, cc1_id::TEXT AS cc1_id, cc2_id::TEXT AS cc2_id, bu_id::TEXT AS bu_id,
           thresholds::TEXT AS thresholds
      FROM budget_alert_thresholds WHERE company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows.map((r) => ({
    glAccountId: String(r.gl_account_id), cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id),
    thresholds: normaliseThresholds(nums(r.thresholds)),
  }));
}

/** The company's overrides with account and slice names, account code order (for the page). */
export async function listThresholdOverrides(companyId: string): Promise<OverrideRow[]> {
  const rows = (await sql`
    SELECT t.id::TEXT AS id, t.gl_account_id::TEXT AS gl_account_id, t.cc1_id::TEXT AS cc1_id, t.cc2_id::TEXT AS cc2_id,
           t.bu_id::TEXT AS bu_id, t.thresholds::TEXT AS thresholds, ga.account_code, ga.account_name,
           COALESCE(cc.code || ' ' || cc.name, b.code || ' ' || b.name) AS slice_name
      FROM budget_alert_thresholds t
      JOIN gl_accounts ga ON ga.id = t.gl_account_id AND ga.company_id = t.company_id
      LEFT JOIN cost_centres cc ON cc.id = COALESCE(t.cc1_id, t.cc2_id) AND cc.company_id = t.company_id
      LEFT JOIN business_units b ON b.id = t.bu_id AND b.company_id = t.company_id
     WHERE t.company_id = ${companyId}::UUID
     ORDER BY ga.account_code, slice_name NULLS FIRST, t.id
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id), glAccountId: String(r.gl_account_id), cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id),
    thresholds: normaliseThresholds(nums(r.thresholds)), accountCode: String(r.account_code), accountName: String(r.account_name),
    sliceName: text(r.slice_name),
  }));
}

export interface OverrideInput {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  thresholds: number[];
}

/** Creates or replaces the override for (account, slice). 400 when the account or slice is not this company's. */
export async function upsertThresholdOverride(companyId: string, userId: string, input: OverrideInput): Promise<OverrideRow> {
  const dims = [input.cc1Id, input.cc2Id, input.buId].filter((d) => d !== null);
  if (dims.length > 1) throw new BudgetControlsError(400, 'An override names at most one dimension: a CC1, a CC2 or a business unit.');
  const acct = (await sql`
    SELECT account_type FROM gl_accounts WHERE id = ${input.glAccountId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!acct[0]) throw new BudgetControlsError(400, 'That account is not one of this company\'s accounts.');
  if (acct[0].account_type !== 'expense') throw new BudgetControlsError(400, 'Alerts watch expense accounts only.');
  const cc = input.cc1Id ?? input.cc2Id;
  if (cc) {
    const kind = input.cc1Id ? 'cc1' : 'cc2';
    const found = (await sql`
      SELECT 1 FROM cost_centres WHERE id = ${cc}::UUID AND company_id = ${companyId}::UUID AND cc_type = ${kind}
    `) as DbRow[];
    if (!found[0]) throw new BudgetControlsError(400, `That ${kind.toUpperCase()} cost centre is not one of this company's.`);
  }
  if (input.buId) {
    const found = (await sql`SELECT 1 FROM business_units WHERE id = ${input.buId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    if (!found[0]) throw new BudgetControlsError(400, 'That business unit is not one of this company\'s.');
  }
  const thresholds = normaliseThresholds(input.thresholds);
  const saved = (await sql`
    INSERT INTO budget_alert_thresholds (company_id, gl_account_id, cc1_id, cc2_id, bu_id, thresholds, created_by)
    VALUES (${companyId}::UUID, ${input.glAccountId}::UUID, ${input.cc1Id}::UUID, ${input.cc2Id}::UUID, ${input.buId}::UUID,
            ${thresholds}::NUMERIC[], ${userId})
    ON CONFLICT ON CONSTRAINT budget_alert_thresholds_one_per_slice
      DO UPDATE SET thresholds = EXCLUDED.thresholds, updated_by = EXCLUDED.created_by
    RETURNING id::TEXT AS id
  `) as DbRow[];
  const id = String(saved[0]!.id);
  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'budget', entityId: companyId, entityRef: 'Budget alert thresholds',
    changes: { fields: [{ field: 'thresholds', label: 'Alert thresholds', old: null, new: thresholds.join(',') }], metadata: { area: 'budget_alert_thresholds', overrideId: id, glAccountId: input.glAccountId } },
  });
  const out = (await listThresholdOverrides(companyId)).find((o) => o.id === id);
  if (!out) throw new Error(`upsertThresholdOverride: saved override ${id} not readable`);
  return out;
}

/** Removes one override (the account falls back to the next most specific thresholds). 404 when not this company's. */
export async function deleteThresholdOverride(companyId: string, userId: string, id: string): Promise<void> {
  const gone = (await sql`
    DELETE FROM budget_alert_thresholds WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING gl_account_id::TEXT AS gl_account_id, thresholds::TEXT AS thresholds
  `) as DbRow[];
  if (!gone[0]) throw new BudgetControlsError(404, 'Threshold override not found');
  await logAuditOrThrow({
    companyId, userId, action: 'delete', entityType: 'budget', entityId: companyId, entityRef: 'Budget alert thresholds',
    changes: { fields: [{ field: 'thresholds', label: 'Alert thresholds', old: String(gone[0].thresholds), new: null }], metadata: { area: 'budget_alert_thresholds', overrideId: id, glAccountId: String(gone[0].gl_account_id) } },
  });
}
