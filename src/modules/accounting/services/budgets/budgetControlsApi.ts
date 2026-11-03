/**
 * The budget controls routes' payloads, one function per route so the route registry
 * (`@/lib/apiRoutes`) types each from its service:
 *   - `readControlsView`: GET (and PUT's answer) of `/api/accounting/budgets/controls`;
 *   - `evaluateNow`: POST `/api/accounting/budgets/alerts/evaluate`, the owner/admin button. It runs
 *     on the request's transaction (app_user under RLS), records "last evaluated" (source 'manual')
 *     in the same transaction, and sends no email (the digest is the daily run's).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { readLastEvaluated, recordEvaluated, type LastEvaluated } from './budgetAlertRuns';
import {
  alertEmailAllowedOnServer, listThresholdOverrides, readControlSettings, type ControlSettings, type OverrideRow,
} from './budgetControlSettings';
import { evaluateOverspend } from './overspendAlerts';

export interface PickOption {
  id: string;
  code: string;
  name: string;
}

/** What an override can name: the company's active expense accounts, CC1/CC2 centres and business units. */
export interface OverrideOptions {
  accounts: PickOption[];
  cc1: PickOption[];
  cc2: PickOption[];
  units: PickOption[];
}

export interface ControlsView {
  settings: ControlSettings;
  overrides: OverrideRow[];
  options: OverrideOptions;
  /** BUDGET_ALERT_EMAIL_ENABLED=1 on this server: without it no budget alert email is sent, whatever the company flag. */
  emailAllowedOnServer: boolean;
  lastEvaluated: LastEvaluated | null;
}

const pick = (rows: DbRow[]): PickOption[] => rows.map((r) => ({ id: String(r.id), code: String(r.code), name: String(r.name) }));

async function overrideOptions(companyId: string): Promise<OverrideOptions> {
  const accounts = (await sql`
    SELECT id::TEXT AS id, account_code AS code, account_name AS name FROM gl_accounts
     WHERE company_id = ${companyId}::UUID AND account_type = 'expense' AND is_active IS TRUE ORDER BY account_code, id
  `) as DbRow[];
  const centres = (await sql`
    SELECT id::TEXT AS id, code, name, cc_type FROM cost_centres
     WHERE company_id = ${companyId}::UUID AND is_active AND cc_type IN ('cc1', 'cc2') ORDER BY code, id
  `) as DbRow[];
  const units = (await sql`
    SELECT id::TEXT AS id, code, name FROM business_units WHERE company_id = ${companyId}::UUID AND is_active IS TRUE ORDER BY code, id
  `) as DbRow[];
  return {
    accounts: pick(accounts),
    cc1: pick(centres.filter((r) => r.cc_type === 'cc1')),
    cc2: pick(centres.filter((r) => r.cc_type === 'cc2')),
    units: pick(units),
  };
}

export async function readControlsView(companyId: string): Promise<ControlsView> {
  return {
    settings: await readControlSettings(companyId),
    overrides: await listThresholdOverrides(companyId),
    options: await overrideOptions(companyId),
    emailAllowedOnServer: alertEmailAllowedOnServer(),
    lastEvaluated: await readLastEvaluated(companyId),
  };
}

export interface EvaluateNowResult {
  fiscalYear: number;
  keys: number;
  fired: number;
  resolved: number;
  lastEvaluated: LastEvaluated | null;
}

export async function evaluateNow(companyId: string): Promise<EvaluateNowResult> {
  const out = await evaluateOverspend(companyId, { asOf: todayInSast() });
  await recordEvaluated(companyId, { source: 'manual', fired: out.fired.length, resolved: out.resolved.length });
  return {
    fiscalYear: out.fiscalYear, keys: out.keys, fired: out.fired.length, resolved: out.resolved.length,
    lastEvaluated: await readLastEvaluated(companyId),
  };
}
