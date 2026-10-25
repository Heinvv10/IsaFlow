// tests/integration/s07e-breaker-webhook-binding.int.test.ts
//
// brk945 round-3 breaker: EXECUTED attacks against the real PG16 fixture.
// Every test asserts the ATTACKER GAINS NOTHING, so a PASS = HELD.
//
// Threat model: the attacker may INSERT paystack_payment_requests rows (every
// column but the card codes) and may start a real Paystack checkout whose
// metadata it chooses — simulated by delivering a signed webhook whose
// metadata/reference we choose for a reference the attacker inserted. The
// billing writes run on migration_admin (945); the webhook binds each action
// to the checkout's Paystack metadata (paystackLinkBinding.ts).
//
// Covers coordinator items (1) attacker PR targeting another company's
// purchase/charge/mandate/invoice, each purpose; (2) a victim's request
// pre-stamped completed/failed/cancelled/abandoned before the genuine event;
// (3) a redelivered/duplicated event; (5) an unlinked authorisation request;
// (7) a genuine checkout of each supported purpose still succeeds.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Readable } from 'stream';
import { createHmac } from 'crypto';
import type { NextApiRequest } from 'next';
import webhookRoute from '../../pages/api/webhooks/paystack';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { billingAdminPool, migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { response } from './mfa-impersonation-postgres.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const paystack = vi.hoisted(() => ({ metadata: null as Record<string, unknown> | null }));
vi.mock('@/modules/billing/services/paystackClient', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));

const WEBHOOK_KEY = 'fixture-paystack-webhook-key-brk945';
const ids = newIds();
const { owner, company, other } = ids; // company = attacker tenant, other = victim
const victimOwner = crypto.randomUUID();
const payg = crypto.randomUUID();
const bundle = crypto.randomUUID();

const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
let seq = 0;
async function deliver(data: Record<string, unknown>, event = 'charge.success') {
  const body = JSON.stringify({ event, data: { id: 70000 + (++seq), status: 'success', currency: 'ZAR', channel: 'card',
    customer: { email: 'attacker@brk945.test', customer_code: 'CUS_brk945' }, ...data } });
  const req = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
  (req as { method: string }).method = 'POST';
  (req as { headers: Record<string, string> }).headers = { 'content-type': 'application/json',
    'x-paystack-signature': createHmac('sha512', WEBHOOK_KEY).update(body).digest('hex') };
  const result = response();
  await webhookRoute(req, result.res);
  return result.state.statusCode;
}

const insertPR = (companyId: string, purpose: string, ref: string, link: Record<string, string | null>, amount = 25000, status = 'pending') => {
  const cols = ['company_id', 'purpose', 'paystack_reference', 'amount_cents', 'currency', 'status', ...Object.keys(link)];
  const vals = [companyId, purpose, ref, amount, 'ZAR', status, ...Object.values(link)];
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
  return q(`INSERT INTO paystack_payment_requests (${cols.join(', ')}) VALUES (${ph})`, vals);
};
const review = async (ref: string) => (await q('SELECT failure_reason, status FROM paystack_payment_requests WHERE paystack_reference = $1', [ref])).rows[0];
const bal = async (c: string) => Number((await q('SELECT balance_flows FROM flow_wallet WHERE company_id = $1', [c])).rows[0]?.balance_flows ?? -1);

// victim artefacts, created per-test and read back
let victimMandate = '';
let victimSub = '';
let attackerSub = '';
let victimCustomer = '';

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('PAYSTACK_SECRET_KEY', WEBHOOK_KEY);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.brk945.test');
  await q(`INSERT INTO users (id, email, role, is_active, status) VALUES ($1, $2, 'viewer', true, 'active')`, [victimOwner, `${victimOwner}@test.local`]);
  await q(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true)`, [other, victimOwner]);
  const existing = (await q(`SELECT id FROM plans WHERE code = 'payg'`)).rows[0]?.id as string | undefined;
  if (!existing) await q(`INSERT INTO plans (id, code, name) VALUES ($1, 'payg', 'brk945 PAYG')`, [payg]);
  await q(`INSERT INTO flow_bundles (id, name, flows, price_cents) VALUES ($1, 'brk945 bundle', 500, 25000)`, [bundle]);
  attackerSub = (await q(`INSERT INTO subscriptions (company_id, plan_id, status) SELECT $1, id, 'active' FROM plans WHERE code='payg' RETURNING id`, [company])).rows[0]!.id;
  victimSub = (await q(`INSERT INTO subscriptions (company_id, plan_id, status) SELECT $1, id, 'active' FROM plans WHERE code='payg' RETURNING id`, [other])).rows[0]!.id;
  victimCustomer = (await q(`SELECT id FROM customers WHERE company_id = $1 LIMIT 1`, [other])).rows[0]!.id;
}, 60000);

afterAll(async () => {
  await q(`DELETE FROM paystack_webhook_events WHERE reference LIKE 'brk945\\_%'`);
  for (const t of ['customer_payments', 'paystack_payment_requests', 'customer_invoices', 'flow_purchases',
    'subscription_charges', 'subscription_mandates', 'subscriptions']) {
    await q(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[company, other]]).catch(() => undefined);
  }
  const c = await fixture.connect();
  try { await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
    await c.query('DELETE FROM flow_ledger WHERE company_id = ANY($1)', [[company, other]]); await c.query('COMMIT'); }
  finally { c.release(); }
  await q('DELETE FROM flow_bundles WHERE id = $1', [bundle]);
  await q('DELETE FROM company_users WHERE user_id = $1', [victimOwner]);
  await q('DELETE FROM users WHERE id = $1', [victimOwner]);
  await q('DELETE FROM plans WHERE id = $1', [payg]).catch(() => undefined);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool()]);
});

beforeEach(async () => {
  await q(`UPDATE flow_wallet SET balance_flows = 100, month_flows_used = 0 WHERE company_id = ANY($1)`, [[company, other]]);
  // flow_ledger is append-only; clear it per test (triggers off) so a credit-once count is this test's only
  const lc = await fixture.connect();
  try { await lc.query('BEGIN'); await lc.query('SET LOCAL session_replication_role = replica');
    await lc.query('DELETE FROM flow_ledger WHERE company_id = ANY($1)', [[company, other]]); await lc.query('COMMIT'); }
  finally { lc.release(); }
  await q(`DELETE FROM paystack_payment_requests WHERE company_id = ANY($1)`, [[company, other]]);
  await q(`DELETE FROM subscription_charges WHERE company_id = ANY($1)`, [[company, other]]);
  await q(`DELETE FROM subscription_mandates WHERE company_id = ANY($1)`, [[company, other]]);
  await q(`DELETE FROM flow_purchases WHERE company_id = ANY($1)`, [[company, other]]);
  // victim's active mandate on the victim's card
  victimMandate = (await q(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, paystack_authorization_code)
    VALUES ($1, 100000, 'active', 'paystack', 'AUTH_victim_real') RETURNING id`, [other])).rows[0]!.id;
});

// ---- (1) attacker-inserted PR targeting ANOTHER company's row, each purpose ----
describe('brk945 (1): attacker PR pointed at a victim row, with the attacker\'s chosen signed metadata', () => {
  it('flow_bundle: a victim purchase cannot be credited to anyone via the attacker\'s request', async () => {
    const victimPurchase = (await q(`INSERT INTO flow_purchases (company_id, bundle_id, flows, price_cents, payment_method)
      VALUES ($1, $2, 500, 25000, 'paystack') RETURNING id`, [other, bundle])).rows[0]!.id as string;
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    // attacker inserts the PR under its OWN company (RLS/insert forces it); points the link at the victim's purchase
    await insertPR(company, 'flow_bundle', ref, { flow_purchase_id: victimPurchase });
    // attacker's best metadata: name its own company (to pass the company gate) and the victim purchase
    expect(await deliver({ reference: ref, amount: 25000, requested_amount: 25000,
      metadata: { purpose: 'flow_bundle', company_id: company, flow_purchase_id: victimPurchase } })).toBe(200);
    expect(await bal(company)).toBe(100);
    expect(await bal(other)).toBe(100);
    expect((await q('SELECT status FROM flow_purchases WHERE id = $1', [victimPurchase])).rows[0]!.status).toBe('pending');
    expect((await review(ref)).failure_reason).toBe('review:flow_purchase_not_credited');
  });

  it('subscription_charge: a victim charge cannot be settled via the attacker\'s request', async () => {
    const charge = (await q(`INSERT INTO subscription_charges (company_id, mandate_id, subscription_id, period_start, period_end,
      amount_cents, external_reference, status, gateway) VALUES ($1,$2,$3,'2026-09-01','2026-09-30',49900,$4,'submitted','paystack') RETURNING id`,
    [other, victimMandate, victimSub, `brk945-${crypto.randomUUID()}`])).rows[0]!.id as string;
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    await insertPR(company, 'subscription_charge', ref, { subscription_charge_id: charge }, 49900);
    expect(await deliver({ reference: ref, amount: 49900, requested_amount: 49900,
      metadata: { purpose: 'subscription_charge', company_id: company, subscription_charge_id: charge } })).toBe(200);
    expect((await q('SELECT status FROM subscription_charges WHERE id = $1', [charge])).rows[0]!.status).toBe('submitted');
  });

  it('authorization: a victim mandate cannot be re-carded/activated via the attacker\'s request', async () => {
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    await insertPR(company, 'authorization', ref, { mandate_id: victimMandate }, 100);
    expect(await deliver({ reference: ref, amount: 100, requested_amount: 100,
      metadata: { purpose: 'authorization', company_id: company, mandate_id: victimMandate },
      authorization: { authorization_code: 'AUTH_attacker_new', reusable: true } })).toBe(200);
    const m = (await q('SELECT status, paystack_authorization_code FROM subscription_mandates WHERE id = $1', [victimMandate])).rows[0];
    expect(m).toEqual({ status: 'active', paystack_authorization_code: 'AUTH_victim_real' });
    expect((await review(ref)).failure_reason).toBe('authorisation_no_mandate_row');
  });

  it('customer_invoice: the DB FK refuses a PR that links the attacker company to a victim invoice', async () => {
    const inv = (await q(`INSERT INTO customer_invoices (company_id, customer_id, invoice_number, created_by, total_amount, status)
      VALUES ($1, $2, 'BRK945-V1', $3, 25000, 'sent') RETURNING id`, [other, victimCustomer, victimOwner])).rows[0]!.id as string;
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    // attacker (company) tries to stage a PR naming the victim's invoice: composite FK (company_id, customer_invoice_id) rejects it.
    await expect(insertPR(company, 'customer_invoice', ref, { customer_invoice_id: inv }))
      .rejects.toThrow(/paystack_payment_requests_invoice_company_fkey/);
    expect((await q('SELECT count(*)::int n FROM customer_payments WHERE company_id = $1', [other])).rows[0]!.n).toBe(0);
    expect((await q('SELECT amount_paid FROM customer_invoices WHERE id = $1', [inv])).rows[0]!.amount_paid).toBe('0.00');
  });
});

// ---- (2) a victim's request pre-stamped before the genuine event ----
describe('brk945 (2): the genuine event still delivers exactly once after a pre-stamp', () => {
  const makePurchase = async () => {
    const purchase = (await q(`INSERT INTO flow_purchases (company_id, bundle_id, flows, price_cents, payment_method)
      VALUES ($1, $2, 500, 25000, 'paystack') RETURNING id`, [other, bundle])).rows[0]!.id as string;
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    await insertPR(other, 'flow_bundle', ref, { flow_purchase_id: purchase });
    return { purchase, ref };
  };
  it.each(['completed', 'failed', 'cancelled', 'abandoned'])('pre-stamped %s then charge.success credits once', async (pre) => {
    const { purchase, ref } = await makePurchase();
    await q(`UPDATE paystack_payment_requests SET status = $2 WHERE paystack_reference = $1`, [ref, pre]);
    const meta = { purpose: 'flow_bundle', company_id: other, flow_purchase_id: purchase };
    expect(await deliver({ reference: ref, amount: 25000, requested_amount: 25000, metadata: meta })).toBe(200);
    expect(await deliver({ reference: ref, amount: 25000, requested_amount: 25000, metadata: meta })).toBe(200); // redelivery too
    expect((await q('SELECT status FROM flow_purchases WHERE id = $1', [purchase])).rows[0]!.status).toBe('succeeded');
    expect(await bal(other)).toBe(600); // 100 baseline + 500 bundle, exactly once
  });
});

// ---- (3) redelivered/duplicated event after the billing write committed ----
describe('brk945 (3): a duplicated event credits/settles nothing twice', () => {
  it('charge.success delivered three times credits a bundle once', async () => {
    const purchase = (await q(`INSERT INTO flow_purchases (company_id, bundle_id, flows, price_cents, payment_method)
      VALUES ($1, $2, 500, 25000, 'paystack') RETURNING id`, [other, bundle])).rows[0]!.id as string;
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    await insertPR(other, 'flow_bundle', ref, { flow_purchase_id: purchase });
    const meta = { purpose: 'flow_bundle', company_id: other, flow_purchase_id: purchase };
    for (let i = 0; i < 3; i++) expect(await deliver({ reference: ref, amount: 25000, requested_amount: 25000, metadata: meta })).toBe(200);
    expect(await bal(other)).toBe(600);
    expect((await q(`SELECT count(*)::int n FROM flow_ledger WHERE company_id = $1 AND type = 'purchase'`, [other])).rows[0]!.n).toBe(1);
  });
});

// ---- (5) an unlinked authorisation request ----
describe('brk945 (5): an authorisation request with no mandate link binds to nothing', () => {
  it('activates no mandate even when a pending one exists', async () => {
    await q(`UPDATE subscription_mandates SET status = 'revoked' WHERE company_id = $1`, [other]);
    const pending = (await q(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway)
      VALUES ($1, 100000, 'pending', 'paystack') RETURNING id`, [other])).rows[0]!.id as string;
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    await insertPR(other, 'authorization', ref, {}, 100); // no mandate_id link
    expect(await deliver({ reference: ref, amount: 100, requested_amount: 100,
      metadata: { purpose: 'authorization', company_id: other },
      authorization: { authorization_code: 'AUTH_unlinked', reusable: true } })).toBe(200);
    expect((await q('SELECT status FROM subscription_mandates WHERE id = $1', [pending])).rows[0]!.status).toBe('pending');
    expect((await review(ref)).failure_reason).toBe('review:no_mandate_id');
  });
});

// ---- (7) genuine checkouts still succeed on the real webhook path ----
describe('brk945 (7): a genuine checkout of each supported purpose still succeeds', () => {
  it('flow_bundle credits', async () => {
    const purchase = (await q(`INSERT INTO flow_purchases (company_id, bundle_id, flows, price_cents, payment_method)
      VALUES ($1, $2, 500, 25000, 'paystack') RETURNING id`, [other, bundle])).rows[0]!.id as string;
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    await insertPR(other, 'flow_bundle', ref, { flow_purchase_id: purchase });
    expect(await deliver({ reference: ref, amount: 25000, requested_amount: 25000,
      metadata: { purpose: 'flow_bundle', company_id: other, flow_purchase_id: purchase } })).toBe(200);
    expect(await bal(other)).toBe(600);
  });
  it('subscription_charge settles', async () => {
    const charge = (await q(`INSERT INTO subscription_charges (company_id, mandate_id, subscription_id, period_start, period_end,
      amount_cents, external_reference, status, gateway) VALUES ($1,$2,$3,'2026-09-01','2026-09-30',49900,$4,'submitted','paystack') RETURNING id`,
    [other, victimMandate, victimSub, `brk945-${crypto.randomUUID()}`])).rows[0]!.id as string;
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    await insertPR(other, 'subscription_charge', ref, { subscription_charge_id: charge }, 49900);
    expect(await deliver({ reference: ref, amount: 49900, requested_amount: 49900,
      metadata: { purpose: 'subscription_charge', company_id: other, subscription_charge_id: charge } })).toBe(200);
    expect((await q('SELECT status FROM subscription_charges WHERE id = $1', [charge])).rows[0]!.status).toBe('settled');
  });
  it('authorization activates the linked pending mandate', async () => {
    await q(`UPDATE subscription_mandates SET status = 'revoked' WHERE company_id = $1`, [other]);
    const pending = (await q(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway)
      VALUES ($1, 100000, 'pending', 'paystack') RETURNING id`, [other])).rows[0]!.id as string;
    const ref = `brk945_${crypto.randomUUID().slice(0, 12)}`;
    await insertPR(other, 'authorization', ref, { mandate_id: pending }, 100);
    expect(await deliver({ reference: ref, amount: 100, requested_amount: 100,
      metadata: { purpose: 'authorization', company_id: other, mandate_id: pending },
      authorization: { authorization_code: 'AUTH_genuine', reusable: true, last4: '4081', brand: 'visa' } })).toBe(200);
    expect((await q('SELECT status FROM subscription_mandates WHERE id = $1', [pending])).rows[0]!.status).toBe('active');
  });
});
