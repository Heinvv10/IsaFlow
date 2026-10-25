// tests/integration/s07e-billing-temp.int.test.ts
//
// S-07e (migration 945): the billing tables and TEMPORARY. SQL injected on
// either app pool can forge request.jwt.claims and app.current_company_id; a
// tenant needs not even that for its own rows. Each statement below would
// give a company Flows or a plan it did not pay for, stop its metering, charge
// another company's card, or plant a temp table that later requests on the
// same pooled connection read instead of the real one:
//   flow_wallet                 the balance, and a stored payment method that
//                               auto top-up credits without a gateway;
//   flow_ledger, flow_purchases the Flows record and the purchase a Paystack
//                               payment completes;
//   flow_bundles, plans,
//   plan_features, feature_flags,
//   company_feature_overrides   what a bundle, a plan or a flag gives;
//   subscriptions,
//   subscription_charges,
//   subscription_mandates       which plan a company is on (PAYG is metered,
//                               anything else is not), its charges, and the
//                               Paystack authorisation a charge is made with;
//   TEMPORARY                   shadowing companies, company_users or any
//                               unqualified table for the next request.
// Production also refuses app-login DDL with an event trigger (runbook step 2);
// these refusals are by privilege, which the fixture shows without it.
// The legitimate paths: s07e-billing-paths*.int.test.ts. The migration and its
// rules: s07e-billing-temp.migration.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { attempt, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
// owner owns `company` (the attacker's tenant); `other` is the victim, owned by
// victimOwner, whose claims the attacker forges.
const { owner, company, other } = ids;
const victimOwner = crypto.randomUUID();
const payg = crypto.randomUUID();
const pro = crypto.randomUUID();
const bundle = crypto.randomUUID();
const mandate = crypto.randomUUID();
const flag = crypto.randomUUID();

beforeAll(async () => {
  await setup(ids);
  const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
  await q(`INSERT INTO users (id, email, role, is_active, status) VALUES ($1, $2, 'viewer', true, 'active')`,
    [victimOwner, `${victimOwner}@test.local`]);
  await q(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true)`, [other, victimOwner]);
  await q('DELETE FROM flow_wallet WHERE company_id = $1', [other]); // the victim has no wallet yet
  await q(`INSERT INTO plans (id, code, name) VALUES ($1, $3, 'S07e PAYG'), ($2, $4, 'S07e pro')`,
    [payg, pro, `payg-${payg.slice(0, 8)}`, `pro-${pro.slice(0, 8)}`]);
  await q(`INSERT INTO feature_flags (id, code, name) VALUES ($1, $2, 'S07e flag')`, [flag, `s07e-${flag.slice(0, 8)}`]);
  await q(`INSERT INTO flow_bundles (id, name, flows, price_cents) VALUES ($1, 'S07e bundle', 100, 10000)`, [bundle]);
  await q(`INSERT INTO subscriptions (company_id, plan_id, status) VALUES ($1, $3, 'active'), ($2, $3, 'active')`, [company, other, payg]);
  await q(`INSERT INTO subscription_mandates (id, company_id, max_amount_cents, status, gateway, paystack_authorization_code,
    paystack_customer_code, paystack_email_token) VALUES ($1, $2, 100000, 'active', 'paystack', 'AUTH_victim', 'CUS_victim', 'tok_victim')`,
  [mandate, other]);
  await q(`INSERT INTO subscription_charges (company_id, mandate_id, subscription_id, period_start, period_end, amount_cents,
    external_reference, status, gateway, paystack_authorization_code) SELECT $1, $2, s.id, '2026-10-01', '2026-10-31', 49900, $3,
    'submitted', 'paystack', 'AUTH_victim' FROM subscriptions s WHERE s.company_id = $1`, [other, mandate, `s07e-${mandate}`]);
  await q(`INSERT INTO flow_purchases (company_id, bundle_id, flows, price_cents, status) VALUES ($1, $2, 100, 10000, 'pending')`,
    [company, bundle]);
}, 60000);

afterAll(async () => {
  const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
  const companies = [company, other];
  for (const t of ['flow_ledger', 'flow_purchases', 'subscription_charges', 'subscription_mandates', 'subscriptions']) {
    await q(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [companies]);
  }
  await q('DELETE FROM company_users WHERE user_id = $1', [victimOwner]);
  await q('DELETE FROM users WHERE id = $1', [victimOwner]);
  await q('DELETE FROM flow_bundles WHERE id = $1', [bundle]);
  await q('DELETE FROM plan_features WHERE plan_id = ANY($1)', [[payg, pro]]);
  await q('DELETE FROM plans WHERE id = ANY($1)', [[payg, pro]]);
  await q('DELETE FROM feature_flags WHERE id = $1', [flag]);
  await teardown(ids, [getAuthPool(), getDbPool()]);
});

const denied = (table: string) => ({ code: '42501', message: `permission denied for table ${table}` });

// Each write fails with division_by_zero when it touches no row, so on a
// database without 945 an attack that "succeeds" by matching nothing is not
// mistaken for a refusal or for a write.
const hit = (dml: string) => `WITH w AS (${dml} RETURNING 1) SELECT 1 / count(*) FROM w`;

/** [what it would do, table, statement, params, whose rows: the attacker's own or the victim's] */
type Attack = [string, string, string, () => unknown[], 'own' | 'victim'];
const ATTACKS: Attack[] = [
  ['its own Flows balance set', 'flow_wallet', hit('UPDATE flow_wallet SET balance_flows = 1000000 WHERE company_id = $1'), () => [company], 'own'],
  ['a payment method planted, which auto top-up credits without a gateway', 'flow_wallet',
    hit(`UPDATE flow_wallet SET payment_method_token = 'forged', auto_topup_enabled = true WHERE company_id = $1`), () => [company], 'own'],
  ['a wallet created with a balance', 'flow_wallet', hit('INSERT INTO flow_wallet (company_id, balance_flows) VALUES ($1, 1000000)'),
    () => [other], 'victim'],
  ['the stored payment method read', 'flow_wallet',
    'SELECT 1 / count(*) FROM flow_wallet WHERE company_id = $1 AND payment_method_token IS NULL', () => [company], 'own'],
  ['a Flows credit recorded', 'flow_ledger', hit(`INSERT INTO flow_ledger (company_id, type, flows, balance_after, reason)
    VALUES ($1, 'purchase', 1000000, 1000000, 'forged')`), () => [company], 'own'],
  ['a cheap purchase of a million Flows', 'flow_purchases', hit(`INSERT INTO flow_purchases (company_id, bundle_id, flows, price_cents)
    VALUES ($1, $2, 1000000, 1)`), () => [company, bundle], 'own'],
  ['a pending purchase inflated', 'flow_purchases', hit('UPDATE flow_purchases SET flows = 1000000 WHERE company_id = $1'), () => [company], 'own'],
  ['a bundle inflated', 'flow_bundles', hit('UPDATE flow_bundles SET flows = 1000000 WHERE id = $1'), () => [bundle], 'own'],
  ['PAYG renamed, so nobody is metered', 'plans', hit('UPDATE plans SET code = code || \'-off\' WHERE id = $1'), () => [payg], 'own'],
  ['a free plan created', 'plans', hit(`INSERT INTO plans (code, name) VALUES ('s07e-free', 'S07e free')`), () => [], 'own'],
  ['a feature added to a plan', 'plan_features', hit('INSERT INTO plan_features (plan_id, feature_id) VALUES ($1, $2)'), () => [payg, flag], 'own'],
  ['a flag made global', 'feature_flags', hit('UPDATE feature_flags SET is_global = true WHERE id = $1'), () => [flag], 'own'],
  ['a feature granted to itself', 'company_feature_overrides', hit(`INSERT INTO company_feature_overrides
    (company_id, feature_id, enabled, set_by) VALUES ($1, $2, true, $3)`), () => [company, flag, owner], 'own'],
  ['its PAYG subscription moved to a plan nobody meters', 'subscriptions',
    hit('UPDATE subscriptions SET plan_id = $2 WHERE company_id = $1'), () => [company, pro], 'own'],
  ['its PAYG subscription cancelled', 'subscriptions', hit(`UPDATE subscriptions SET status = 'cancelled' WHERE company_id = $1`),
    () => [company], 'own'],
  ['an active subscription to another plan created', 'subscriptions', hit(`INSERT INTO subscriptions (company_id, plan_id, status)
    VALUES ($1, $2, 'active')`), () => [company, pro], 'own'],
  ['a charge marked settled', 'subscription_charges', hit(`UPDATE subscription_charges SET status = 'settled', settled_at = NOW()
    WHERE company_id = $1`), () => [other], 'victim'],
  ['another company\'s card authorisation read off a charge', 'subscription_charges',
    'SELECT 1 / count(*) FROM subscription_charges WHERE company_id = $1 AND paystack_authorization_code IS NOT NULL', () => [other], 'victim'],
  ['another company\'s card authorisation read', 'subscription_mandates',
    'SELECT 1 / count(*) FROM subscription_mandates WHERE company_id = $1 AND paystack_authorization_code IS NOT NULL', () => [other], 'victim'],
  ['its mandate pointed at another company\'s card', 'subscription_mandates', hit(`UPDATE subscription_mandates
    SET paystack_authorization_code = 'AUTH_victim', paystack_customer_code = 'CUS_victim' WHERE id = $1`), () => [mandate], 'victim'],
  ['an active mandate on a stolen card created', 'subscription_mandates', hit(`INSERT INTO subscription_mandates
    (company_id, max_amount_cents, status, gateway, paystack_authorization_code) VALUES ($1, 100000, 'active', 'paystack',
    'AUTH_victim')`), () => [company], 'own'],
];

type Opts = Parameters<typeof attempt>[2];
const own: Opts = { asRequest: { sub: owner, companyId: company } };
const forged: Opts = { asRequest: { sub: victimOwner, companyId: other } };
/** [pool, login, options for the attacker's own rows, options for the victim's] */
const pools: Array<[string, () => Pool, Opts, Opts]> = [
  // Its own wallet, plan and subscription need no forgery; the victim's need the victim owner's forged claims.
  ['isaflow_app, own claims or the victim owner\'s forged ones', getAuthPool, own, forged],
  ['isaflow_service with no claims', getDbPool, {}, {}],
  ['isaflow_service under the owner\'s claims', getDbPool, { claims: own.asRequest! }, { claims: own.asRequest! }],
];

const TEMP_DENIED = { code: '42501', message: expect.stringMatching(/^permission denied to create temporary tables in database /) };
const TEMPS: Array<[string, string]> = [
  ['a temp companies table', 'CREATE TEMP TABLE companies (id uuid, status text)'],
  ['a temp company_users table, by SELECT INTO', 'SELECT NULL::uuid AS company_id, NULL::text AS user_id INTO TEMP company_users'],
  ['a temp view', 'CREATE TEMP VIEW users AS SELECT 1 AS id'],
  ['a temp type that shadows a cast', 'CREATE TYPE pg_temp.text AS (x int)'],
];

describe.each(pools)('S-07e (945): %s', (_, pool, ownOpts, victimOpts) => {
  const opts = ownOpts;
  it.each(ATTACKS)('cannot: %s', async (_what, table, text, params, whose) => {
    expect(await attempt(pool(), [[text, params()]], whose === 'own' ? ownOpts : victimOpts)).toEqual(denied(table));
  });

  const firstPerTable = ATTACKS.filter(([, t], i) => ATTACKS.findIndex(([, u]) => u === t) === i);
  it.each(firstPerTable)('cannot: %s, after set_config(role, none) either', async (_what, table, text, params, whose) => {
    expect(await attempt(pool(), [[`SELECT set_config('role', 'none', true)`], [text, params()]],
      whose === 'own' ? ownOpts : victimOpts)).toEqual(denied(table));
  });

  it.each(TEMPS)('cannot create %s', async (_what, text) => {
    expect(await attempt(pool(), [[text]], opts)).toEqual(TEMP_DENIED);
    expect(await attempt(pool(), [[`SELECT set_config('role', 'none', true)`], [text]], opts)).toEqual(TEMP_DENIED);
  });
});

describe('S-07e (945): what an app role may still read', () => {
  it.each([
    ['its wallet, without the payment method', `SELECT company_id, balance_flows, auto_topup_enabled, auto_topup_bundle_id, nudge_level,
      month_flows_used, month_reset_at, updated_at FROM flow_wallet WHERE company_id = $1`],
    ['its plan, as metering decides it', `SELECT s.id, p.id, p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.company_id = $1 AND s.status = 'active'`],
    ['the plans', 'SELECT * FROM plans WHERE $1::uuid IS NOT NULL'],
    ['its mandate\'s card summary', `SELECT id, status, bank_name, card_last4, card_brand, card_exp_month, card_exp_year, max_amount_cents,
      authorised_at FROM subscription_mandates WHERE company_id = $1`],
    ['its charges', `SELECT id, period_start, period_end, amount_cents, status, attempt_count, last_attempt_at, settled_at, failure_reason
      FROM subscription_charges WHERE company_id = $1`],
    ['its Flows history', 'SELECT * FROM flow_ledger WHERE company_id = $1'],
    ['its purchases', 'SELECT * FROM flow_purchases WHERE company_id = $1'],
    ['the bundles', 'SELECT * FROM flow_bundles WHERE $1::uuid IS NOT NULL'],
    ['its features', `SELECT ff.code, cfo.enabled FROM feature_flags ff LEFT JOIN company_feature_overrides cfo
      ON cfo.feature_id = ff.id AND cfo.company_id = $1 LEFT JOIN plan_features pf ON pf.feature_id = ff.id`],
  ])('%s, in a request', async (_, text) => {
    expect(await attempt(getAuthPool(), [[text, [company]]], { asRequest: { sub: owner, companyId: company } })).toBeNull();
  });
});
