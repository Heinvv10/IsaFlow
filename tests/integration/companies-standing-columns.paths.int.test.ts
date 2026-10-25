// tests/integration/companies-standing-columns.paths.int.test.ts
//
// Migration 936 took INSERT/UPDATE/DELETE on companies off app_user and gave
// UPDATE back on every column but 13 (status, plan, trial, PAYG, ...). This
// suite proves every LEGITIMATE app-pool writer of companies still works,
// through its real route and withAuth, on the production logins (isaflow_app
// via s07b's setup): Company Settings, the onboarding wizard, chase settings,
// the CIPC flag, the logo, the PIS inputs and the bank-query WhatsApp number.
// Each test reads the written values back on the fixture's own connection and
// checks that the 13 locked columns did not move. The attacks:
// companies-standing-columns.int.test; the admin site and signup:
// companies-standing-columns.admin.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { mapApiCompany } from '@/components/accounting/settings/mapApiCompany';
import companiesRoute from '../../pages/api/accounting/companies';
import chaseRoute from '../../pages/api/accounting/chase-settings';
import cipcRoute from '../../pages/api/accounting/cipc-annual-return';
import logoRoute from '../../pages/api/accounting/company-logo';
import pisRoute from '../../pages/api/accounting/afs/pis-score';
import queriesRoute from '../../pages/api/accounting/bank-tx-queries';
import querySettingsRoute from '../../pages/api/accounting/bank-tx-queries/settings';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';
import { callSetup, dropSetupUsers, newSetupUser, PNG, setupBody, type SetupUser } from './helpers/onboardingSetupFixture';
import { clearRateLimits, column, standing } from './companies-standing-columns.helpers';

// The WhatsApp send is Twilio's, outside this system; everything else is real.
vi.mock('@/modules/accounting/services/capture/whatsAppReplyService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/capture/whatsAppReplyService')>()),
  sendWhatsAppMessage: vi.fn(async () => ({ sent: true, sid: 'SM936' })),
}));

const ids = newIds();
const { company, me, owner } = ids;
const plan = crypto.randomUUID();
const bankAccount = crypto.randomUUID();
const bankTx = crypto.randomUUID();
const setupUsers: SetupUser[] = [];
let before: Record<string, unknown>;

beforeAll(async () => {
  await setup(ids);
  await fixture.query(`INSERT INTO plans (id, code, name) VALUES ($1, $2, '936 paths plan')`, [plan, `p936p-${plan.slice(0, 8)}`]);
  // Standing values no legitimate app-pool writer may disturb.
  await fixture.query(`UPDATE companies SET plan_id = $2, trial_ends_at = NOW() + interval '9 days', payg_eligible = true,
    stripe_customer_id = 'cus_936', billing_email = 'billing@936.test', billing_contact = 'Bill 936',
    metadata = '{"seed": 936}', suspended_reason = 'none yet' WHERE id = $1`, [company, plan]);
  before = await standing(company);
  await fixture.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance)
    VALUES ($1, $2, '1100-936', '936 bank', 'asset', 'debit')`, [bankAccount, company]);
  await fixture.query(`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description)
    VALUES ($1, $2, $3, '2026-10-01', -123.45, '936 query probe')`, [bankTx, company, bankAccount]);
}, 60000);

afterAll(async () => {
  try {
    await fixture.query('DELETE FROM bank_transactions WHERE id = $1', [bankTx]); // bank_tx_queries cascade
    await fixture.query('DELETE FROM gl_accounts WHERE id = $1', [bankAccount]);
    for (const u of setupUsers) {
      const owned = (await fixture.query('SELECT company_id FROM company_users WHERE user_id = $1', [u.userId])).rows
        .map((r: { company_id: string }) => r.company_id);
      for (const id of owned) {
        for (const t of ['close_runs', 'gl_journal_entries', 'subscriptions']) {
          await fixture.query(`DELETE FROM ${t} WHERE company_id = $1`, [id]);
        }
      }
    }
    await dropSetupUsers(fixture, setupUsers);
    await clearRateLimits();
    await fixture.query('UPDATE companies SET plan_id = NULL WHERE id = $1', [company]);
    await fixture.query('DELETE FROM plans WHERE id = $1', [plan]);
  } finally {
    await teardown(ids, [getAuthPool(), getDbPool()]);
  }
}, 60000);

const as = (sub: string) => ({ sub, companyId: company });
const read = async (cols: string[]) => (await fixture.query(
  `SELECT ${cols.map((c) => `${c}::text AS ${c}`).join(', ')} FROM companies WHERE id = $1`, [company])).rows[0] as Record<string, string | null>;

/** [payload key the settings page sends, column it lands in, new value], across every tab. */
const SETTINGS: Array<[string, string, string | number | boolean]> = [
  ['tradingName', 'trading_name', '936 Trading'], ['phone', 'phone', '0115550936'], ['bankName', 'bank_name', '936 Bank'],
  ['physicalCity', 'physical_city', 'Pretoria'], ['sarsContactFirstName', 'sars_contact_first_name', 'Sars'], // details
  ['dateFormat', 'date_format', 'yyyy-mm-dd'], ['qtyDecimalPlaces', 'qty_decimal_places', 3],
  ['warnItemCostZero', 'warn_item_cost_zero', true], ['lockdownEnabled', 'lockdown_enabled', true],
  ['lockdownDate', 'lockdown_date', '2026-01-31'], // general
  ['vatPeriod', 'vat_period', 'monthly'], ['vatSystemType', 'vat_system_type', 'payment'],
  ['vatPeriodAlignment', 'vat_period_alignment', 'even'], // vat
  ['logoPosition', 'logo_position', 'top-right'], ['invoiceLayout', 'invoice_layout', 'modern'],
  ['logoOnEmails', 'logo_on_emails', false], // branding
  ['agingBucket1Days', 'aging_bucket1_days', 15], ['agingBasis', 'aging_basis', 'invoice_date'], // aging
  ['invoiceEmailBody', 'invoice_email_body', 'Dear 936'], ['quoteEmailSubject', 'quote_email_subject', 'Quote 936'], // email templates
  ['decimalSeparator', 'decimal_separator', ','], ['decimalPlaces', 'decimal_places', 4], // regional
  ['portalDisplayName', 'portal_display_name', '936 portal'], ['portalMode', 'portal_mode', 'invoices_only'],
  ['portalAllowPayments', 'portal_allow_payments', false], // customer zone
  ['idleTimeoutMinutes', 'idle_timeout_minutes', 120],
];

describe('936: Company Settings (PUT /api/accounting/companies)', () => {
  // The page loads the company with GET ?id=, maps it, and PUTs the whole mapped company back.
  const pagePayload = async () => {
    const got = await callRoute(companiesRoute, { ...as(me), method: 'GET', query: { id: company } });
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    return mapApiCompany((got.body as { data: Record<string, unknown> }).data);
  };

  it('saves what every tab edited, as the company admin, and the locked columns stay put', async () => {
    const payload: Record<string, unknown> = { ...(await pagePayload()) };
    for (const [key, , value] of SETTINGS) payload[key] = value;
    const put = await callRoute(companiesRoute, { ...as(me), method: 'PUT', body: payload });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await read(SETTINGS.map(([, col]) => col))).toEqual(
      Object.fromEntries(SETTINGS.map(([, col, value]) => [col, String(value)])));
    expect(await standing(company)).toEqual(before);
    // ...and the saved company loads back through the page's own GET.
    expect(await pagePayload()).toMatchObject({ tradingName: '936 Trading', vatPeriod: 'monthly', portalMode: 'invoices_only' });
  });

  it('forged standing keys in the body are ignored: the other fields save, the 13 do not move', async () => {
    const forged = { status: 'suspended', isActive: false, planId: crypto.randomUUID(), paygEligible: false, isDemo: true,
      trialEndsAt: '2099-01-01', stripeCustomerId: 'cus_forged', billingEmail: 'x@evil.test', billingContact: 'x',
      fxDocumentsEnabled: true, metadata: { forged: true }, suspendedReason: 'x' };
    const put = await callRoute(companiesRoute, { ...as(me), method: 'PUT', body: { id: company, tradingName: '936 forged-keys', ...forged } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await read(['trading_name'])).trading_name).toBe('936 forged-keys');
    expect(await standing(company)).toEqual(before);
  });

  it('a company viewer is refused and nothing is written', async () => {
    const viewer = crypto.randomUUID();
    await fixture.query(`INSERT INTO users (id, email, role, is_active, status) VALUES ($1, $2, 'viewer', true, 'active')`,
      [viewer, `${viewer}@test.local`]);
    await fixture.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'viewer', true)`, [company, viewer]);
    const unchanged = await read(['trading_name', 'name']);
    try {
      const put = await callRoute(companiesRoute, { ...as(viewer), method: 'PUT', body: { id: company, tradingName: '936 viewer' } });
      expect(put.status).toBe(403);
      expect(await read(['trading_name', 'name'])).toEqual(unchanged);
    } finally {
      await fixture.query('DELETE FROM company_users WHERE user_id = $1', [viewer]);
      await fixture.query('DELETE FROM users WHERE id = $1', [viewer]);
    }
  });
});

describe('936: onboarding complete-setup creates a company on the app pool', () => {
  it('creates it with the default standing, records the entity type and request key', async () => {
    const u = await newSetupUser(fixture);
    setupUsers.push(u);
    const body = setupBody('other');
    const out = await callSetup(u, body);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const created = out.body.data!.companyId!;
    expect(created).not.toBe(u.homeCompanyId);
    const row = (await fixture.query(`SELECT name, entity_type, financial_year_start, vat_period,
      onboarding_request_key = md5($2 || ':' || $3)::uuid AS keyed FROM companies WHERE id = $1`,
    [created, u.userId, body.requestKey])).rows[0];
    expect(row).toEqual({ name: body.company.name, entity_type: 'other', financial_year_start: 3, vat_period: 'none', keyed: true });
    expect(await standing(created)).toEqual({ status: 'active', suspended_at: null, suspended_reason: null, is_active: true,
      plan_id: null, trial_ends_at: null, stripe_customer_id: null, payg_eligible: false, is_demo: false,
      fx_documents_enabled: false, metadata: {}, billing_email: null, billing_contact: null });
    expect((await fixture.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [created, u.userId])).rows)
      .toEqual([{ role: 'owner' }]);
  }, 60000);
});

describe('936: the other app-pool writers', () => {
  it('chase settings (PATCH) persist and the locked columns stay put', async () => {
    const r = await callRoute(chaseRoute, { ...as(me), method: 'PATCH',
      body: { chaseAutoSendEnabled: true, chaseGraceDays: 5, whatsappChaseEnabled: true } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await read(['chase_auto_send_enabled', 'chase_grace_days', 'whatsapp_chase_enabled']))
      .toEqual({ chase_auto_send_enabled: 'true', chase_grace_days: '5', whatsapp_chase_enabled: 'true' });
    expect(await standing(company)).toEqual(before);
  });

  it('the CIPC annual return flag is set with its timestamp, then cleared', async () => {
    const on = await callRoute(cipcRoute, { ...as(me), method: 'PATCH', body: { submitted: true } });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(await read(['cipc_annual_return_submitted'])).toEqual({ cipc_annual_return_submitted: 'true' });
    expect(await column(company, 'cipc_annual_return_submitted_at')).not.toBeNull();
    const off = await callRoute(cipcRoute, { ...as(me), method: 'PATCH', body: { submitted: false } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await column(company, 'cipc_annual_return_submitted')).toBe(false);
    expect(await column(company, 'cipc_annual_return_submitted_at')).toBeNull();
    expect(await standing(company)).toEqual(before);
  });

  it('the company logo is stored by the owner', async () => {
    const r = await callRoute(logoRoute, { ...as(owner), method: 'POST', body: { companyId: company, logoData: PNG } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await column(company, 'logo_data')).toBe(PNG);
    expect(await standing(company)).toEqual(before);
  });

  it('the PIS inputs (PUT) persist, entity type re-sent by an admin included', async () => {
    const r = await callRoute(pisRoute, { ...as(me), method: 'PUT', body: { employeeCountBeginning: 7, employeeCountEnd: 9,
      shareholderCount: 2, allShareholdersAreDirectors: true, natureOfBusiness: 'Fibre 936', registeredAddress: '1 Main Rd',
      entityType: 'pty_ltd' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await read(['employee_count_beginning', 'employee_count_end', 'shareholder_count', 'all_shareholders_are_directors',
      'nature_of_business', 'registered_address', 'entity_type'])).toEqual({ employee_count_beginning: '7', employee_count_end: '9',
      shareholder_count: '2', all_shareholders_are_directors: 'true', nature_of_business: 'Fibre 936',
      registered_address: '1 Main Rd', entity_type: 'pty_ltd' });
    expect(await standing(company)).toEqual(before);
  });

  it('the client-query WhatsApp number is saved from its settings route (normalised) and cleared', async () => {
    const set = await callRoute(querySettingsRoute, { ...as(me), method: 'PATCH', body: { clientQueryWhatsapp: '082 123 4567' } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(await column(company, 'client_query_whatsapp')).toBe('+27821234567');
    const clear = await callRoute(querySettingsRoute, { ...as(me), method: 'PATCH', body: { clientQueryWhatsapp: null } });
    expect(clear.status, JSON.stringify(clear.body)).toBe(200);
    expect(await column(company, 'client_query_whatsapp')).toBeNull();
    expect(await standing(company)).toEqual(before);
  });

  it('sending a bank-transaction query with saveAsDefault saves the number as the default', async () => {
    const r = await callRoute(queriesRoute, { ...as(me), method: 'POST',
      body: { bankTransactionId: bankTx, toNumber: '+27831112222', saveAsDefault: true } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await column(company, 'client_query_whatsapp')).toBe('+27831112222');
    expect((await fixture.query('SELECT to_number, status FROM bank_tx_queries WHERE company_id = $1', [company])).rows)
      .toEqual([{ to_number: '+27831112222', status: 'sent' }]);
    expect(await standing(company)).toEqual(before);
  });
});
