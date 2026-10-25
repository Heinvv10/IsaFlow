/**
 * Shared by companies-standing-columns.paths and .admin: the 13 columns
 * migration 936 takes off the app pools, read back as one comparable row.
 */
import { fixture } from './s07b-app-pool-login-role.helpers';

export const LOCKED_COLUMNS = ['status', 'suspended_at', 'suspended_reason', 'is_active', 'plan_id', 'trial_ends_at',
  'stripe_customer_id', 'payg_eligible', 'is_demo', 'fx_documents_enabled', 'metadata', 'billing_email', 'billing_contact',
] as const;

/** The standing columns of one company, read on the fixture's own connection. */
export async function standing(companyId: string): Promise<Record<string, unknown>> {
  const r = await fixture.query(`SELECT ${LOCKED_COLUMNS.join(', ')} FROM companies WHERE id = $1`, [companyId]);
  if (r.rows.length !== 1) throw new Error(`company ${companyId} not found`);
  return r.rows[0] as Record<string, unknown>;
}

/** One column of one company. */
export async function column(companyId: string, name: string): Promise<unknown> {
  const r = await fixture.query(`SELECT ${name} AS v FROM companies WHERE id = $1`, [companyId]);
  return (r.rows[0] as { v: unknown } | undefined)?.v;
}

/** Rate-limit buckets the request fixture's address (127.0.0.79) fills. */
export async function clearRateLimits(): Promise<void> {
  await fixture.query(`DELETE FROM rate_limit_counters WHERE key LIKE '%127.0.0.79%'`);
}

/**
 * Remove companies a test created through a route (admin create, waitlist
 * promotion, signup), with the rows that do not cascade from them.
 */
export async function dropCompanies(companyIds: string[]): Promise<void> {
  if (companyIds.length === 0) return;
  await fixture.query('UPDATE waitlist_signups SET promoted_company_id = NULL WHERE promoted_company_id = ANY($1::uuid[])', [companyIds]);
  await fixture.query(`DELETE FROM gl_account_balances WHERE gl_account_id IN
    (SELECT id FROM gl_accounts WHERE company_id = ANY($1::uuid[]))`, [companyIds]);
  for (const t of ['subscription_charges', 'subscriptions', 'company_users', 'gl_accounts', 'fiscal_periods']) {
    await fixture.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
  }
  await fixture.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
}
