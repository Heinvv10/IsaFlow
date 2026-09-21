// tests/integration/k096-webhook-mandate-scoping.int.test.ts
//
// HIGH-1 from the blind review of fb63f304. K-096 scoped the mandate write in
// the verify route but left the identical company-wide statement in the
// charge.success webhook handler — the path the route's own doc comment calls
// "the source of truth long-term", and whose predicate was wider still
// (status IN ('pending','active')).
//
// With two pending mandates on one company — the ordinary result of an
// abandoned-then-retried checkout — that UPDATE raises 23505 on
// ux_sub_mandates_company_active. processEvent runs the handlers in one
// transaction, so the throw rolls the whole event back, the webhook answers
// 500, and every Paystack redelivery hits the same constraint: the mandate
// never activates through the webhook at all.
//
// Cases:
//   1. The linked mandate (migration 651) is activated; the abandoned sibling
//      stays pending and nothing throws.
//   2. A payment request written before migration 651 has no link and still
//      resolves to exactly ONE mandate rather than the whole company.
//   3. Another tenant's pending mandate is never touched.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

vi.mock('@/modules/accounting/services/ar/gatewayInvoiceReceiptService', () => ({
  recordGatewayInvoiceReceipt: vi.fn(),
}));

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const LINKED_REF = `k096w_${randomUUID().slice(0, 8)}`;
const LEGACY_REF = `k096l_${randomUUID().slice(0, 8)}`;

let abandonedMandate: string;
let authorisedMandate: string;
let legacyMandate: string;
let otherTenantMandate: string;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

function chargeSuccess(reference: string) {
  return {
    event: 'charge.success',
    data: {
      reference,
      status: 'success',
      id: 424242,
      customer: { customer_code: 'CUS_k096w' },
      authorization: {
        authorization_code: 'AUTH_k096w',
        last4: '4321',
        brand: 'visa',
        exp_month: '05',
        exp_year: '2030',
        bank: 'Test Bank',
      },
    },
  };
}

describeIfDb('K-096 webhook mandate activation is scoped to one mandate', () => {
  let admin: Pool;
  let processEvent: (t: string, e: ReturnType<typeof chargeSuccess>) => Promise<void>;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active)
       VALUES ($1, 'K096 Webhook Fixture', true), ($2, 'K096 Webhook Other Tenant', true)`,
      [COMPANY, OTHER_COMPANY],
    );

    // The abandoned checkout, then the retry the customer actually completed.
    const a = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 100000, 'pending', 'paystack', now() - interval '2 days') RETURNING id`,
      [COMPANY],
    );
    abandonedMandate = a.rows[0].id;
    const b = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 900000, 'pending', 'paystack', now() - interval '1 day') RETURNING id`,
      [COMPANY],
    );
    authorisedMandate = b.rows[0].id;

    const c = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 700000, 'pending', 'paystack', now()) RETURNING id`,
      [OTHER_COMPANY],
    );
    otherTenantMandate = c.rows[0].id;
    const d = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 300000, 'pending', 'paystack', now() - interval '3 days') RETURNING id`,
      [OTHER_COMPANY],
    );
    legacyMandate = d.rows[0].id;

    // The linked request points at the OLDER of the company's two pending
    // mandates on purpose: a heuristic that picks the newest would get this
    // wrong, and the activated ceiling would be one the customer never
    // authorised on this reference.
    await admin.query(
      `INSERT INTO paystack_payment_requests
         (company_id, purpose, mandate_id, paystack_reference, amount_cents, currency, status)
       VALUES ($1, 'authorization', $2, $3, 100, 'ZAR', 'pending')`,
      [COMPANY, authorisedMandate, LINKED_REF],
    );
    // A pre-651 row: no link at all.
    await admin.query(
      `INSERT INTO paystack_payment_requests
         (company_id, purpose, paystack_reference, amount_cents, currency, status)
       VALUES ($1, 'authorization', $2, 100, 'ZAR', 'pending')`,
      [OTHER_COMPANY, LEGACY_REF],
    );

    ({ processEvent } = (await import(
      '../../src/modules/billing/services/paystackEventHandlers'
    )) as unknown as { processEvent: typeof processEvent });
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM paystack_payment_requests WHERE company_id = ANY($1)', [
      [COMPANY, OTHER_COMPANY],
    ]);
    await admin.query('DELETE FROM subscription_mandates WHERE company_id = ANY($1)', [
      [COMPANY, OTHER_COMPANY],
    ]);
    await admin.query('DELETE FROM companies WHERE id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
    await admin.end();
  });

  async function statuses(companyId: string) {
    const r = await admin.query(
      `SELECT id, status, paystack_authorization_code FROM subscription_mandates WHERE company_id = $1`,
      [companyId],
    );
    return new Map<string, { status: string; code: string | null }>(
      r.rows.map((x: { id: string; status: string; paystack_authorization_code: string | null }) => [
        x.id,
        { status: x.status, code: x.paystack_authorization_code },
      ]),
    );
  }

  it('activates only the linked mandate and does not raise 23505', async () => {
    await expect(processEvent('charge.success', chargeSuccess(LINKED_REF))).resolves.toBeUndefined();

    const s = await statuses(COMPANY);
    expect(s.get(authorisedMandate)!.status).toBe('active');
    expect(s.get(authorisedMandate)!.code).toBe('AUTH_k096w');
    // The abandoned sibling is untouched — no second active row, so the
    // single-active-mandate index is never challenged.
    expect(s.get(abandonedMandate)!.status).toBe('pending');
    expect(s.get(abandonedMandate)!.code).toBeNull();

    const active = await admin.query(
      `SELECT COUNT(*)::int AS n FROM subscription_mandates WHERE company_id = $1 AND status = 'active'`,
      [COMPANY],
    );
    expect(active.rows[0].n).toBe(1);
  });

  it('a pre-651 request with no link still activates exactly one mandate', async () => {
    await expect(processEvent('charge.success', chargeSuccess(LEGACY_REF))).resolves.toBeUndefined();

    const s = await statuses(OTHER_COMPANY);
    // Newest pending wins, which is the old heuristic — but scoped to one row.
    expect(s.get(otherTenantMandate)!.status).toBe('active');
    expect(s.get(legacyMandate)!.status).toBe('pending');
  });

  it('leaves the first tenant untouched when the second tenant authorises', async () => {
    const s = await statuses(COMPANY);
    expect(s.get(authorisedMandate)!.status).toBe('active');
    expect(s.get(abandonedMandate)!.status).toBe('pending');
  });
});
