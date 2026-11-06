/**
 * The generic settings route (PUT /api/accounting/accounting-settings {key, value}) writes only the keys the settings
 * pages save there. It must not be a way round the owner/admin gate on the company's default payment terms (written by
 * company-settings?type=payment-terms alone), nor round the other settings' own routes. Through the real route as a
 * write user who is not an admin; the stored row is read back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import settingsRoute from '../../pages/api/accounting/accounting-settings';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { setSetting } from '../../src/modules/accounting/services/core/currencyService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '', manager = '', accountant = '';

beforeAll(async () => { [admin, manager, accountant] = await members(pool, tokens, 3); });
afterAll(async () => {
  await pool.query('DELETE FROM accounting_settings WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin, manager, accountant]);
});

const company = () => newCompany(pool, [[admin, 'admin'], [manager, 'manager'], [accountant, 'accountant']], companies);
const put = (user: string, c: string, body: unknown) =>
  callRoute(settingsRoute, tokens[user]!, c, 'PUT', body, '/api/accounting/accounting-settings');
const stored = async (c: string, key: string) =>
  (await pool.query('SELECT value FROM accounting_settings WHERE company_id = $1 AND key = $2', [c, key])).rows[0]?.value as string | undefined;
const SIXTY = JSON.stringify({ days: 60, type: 'invoice_days' });

describe('the generic settings route cannot write the default payment terms', () => {
  // manager passes withWriteAccess (owner/admin/manager) and meets the route's key allowlist: 400. accountant is not a write
  // role: withWriteAccess answers 403 before the handler runs.
  it.each([['manager', 400], ['accountant', 403]])('a %s PUTting default_payment_terms is refused with %i and the stored default is unchanged', async (who, status) => {
    const c = await company();
    await pool.query("INSERT INTO accounting_settings(company_id, key, value) VALUES($1, 'default_payment_terms', $2)", [c, SIXTY]);
    const res = await put({ manager, accountant }[who]!, c, { key: 'default_payment_terms', value: JSON.stringify({ days: 1, type: 'invoice_days' }) });
    expect(res.state.statusCode, messageOf(res)).toBe(status);
    expect(await stored(c, 'default_payment_terms')).toBe(SIXTY);
    expect((await pool.query("SELECT 1 FROM entity_changes WHERE company_id = $1 AND entity_type = 'company_setting'", [c])).rows).toHaveLength(1); // the seed only
  });

  it('an admin is refused here too: the one door is company-settings?type=payment-terms', async () => {
    const c = await company();
    const res = await put(admin, c, { key: 'default_payment_terms', value: SIXTY });
    expect(res.state.statusCode, messageOf(res)).toBe(400);
    expect(await stored(c, 'default_payment_terms')).toBeUndefined();
  });

  it('an unknown key is a 400 and writes nothing', async () => {
    const c = await company();
    const res = await put(manager, c, { key: 'budget_alert_last_run', value: 'x' });
    expect(res.state.statusCode, messageOf(res)).toBe(400);
    expect(await stored(c, 'budget_alert_last_run')).toBeUndefined();
  });

  it.each([['reporting_currency', 'EUR'], ['enable_cost_centres', 'true'], ['enable_business_units', 'false'], ['document_display_fields', '["a"]']])(
    'the UI key %s still saves (by a write user)', async (key, value) => {
      const c = await company();
      const res = await put(manager, c, { key, value });
      expect(res.state.statusCode, messageOf(res)).toBe(200);
      expect(await stored(c, key)).toBe(value);
    });

  it('setSetting itself refuses the key: only setCompanyDefaultTerms writes it', async () => {
    const c = await company();
    await expect(setSetting('default_payment_terms', SIXTY, admin, c)).rejects.toThrow(/setCompanyDefaultTerms/);
    expect(await stored(c, 'default_payment_terms')).toBeUndefined();
  });
});
