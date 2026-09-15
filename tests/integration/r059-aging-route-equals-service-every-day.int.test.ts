/**
 * R-059 — the ageing routes equal the ageing services at EVERY day from before
 * the first invoice to today, on every settlement kind the shared rewind
 * handles, and the figure is the true balance at each day that changes it.
 *
 * Adapted from the round-1 reviewer's probe. r059-aging-route-point-in-time
 * pins payments only; this adds credit notes, a bad-debt write-off and a credit
 * note cancelled since, and sweeps every day so a boundary cannot hide between
 * sampled dates. The route's per-invoice rows must add up to its summary.
 *
 *   AR  X 1000 (raised −100, due −90): 300 paid −60, credit note 100 on −20
 *       Z  500: written off −25 (status 'paid' today)
 *       W  800: credit note 200 on −50, cancelled −10 12:00 SAST
 *       V  250: raised −35
 *   AP  X, W, V the same; there is no supplier write-off
 *
 *   AR truth: −101 0 · −100 2300 · −60 2000 · −50 1800 · −35 2050 · −25 1550
 *             · −20 1450 · −11 1450 · −9 1650 · today 1650
 *   AP truth: −101 0 · −100 1800 · −60 1500 · −50 1300 · −35 1550 · −20 1450
 *             · −11 1450 · −9 1650 · today 1650
 *
 * NOT asserted: the truth ON −10, the cancellation day. agingRewind compares
 * cancelled_at with midnight UTC there, which is registered as R-074; the
 * route == service sweep still covers that day, since both share the helper.
 * Nor is a payment later cancelled seeded: that is agingRewind's documented
 * limitation 1, and a truth assertion over it would pin a known wrong figure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';
import arAgingRoute from '../../pages/api/accounting/reports-ar-aging';
import apAgingRoute from '../../pages/api/accounting/reports-ap-aging';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
// Short: it is the prefix of payment_number and write_off_number, both VARCHAR(30).
const TAG = `R59D-${Math.floor(Math.random() * 1e9)}`;
function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
let customer = ''; let supplier = ''; let token = '';

type Summary = { bucket: string; count: number; total: number };
type Body = { rows: { invoice_number: string; balance_due: number }[]; summary: Summary[] };
async function callRoute(route: unknown, asAt: string): Promise<Body> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = { as_at_date: asAt };
  const result = response();
  await (route as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: Body }).data;
}
const total = (b: Body) => Math.round(b.summary.reduce((s, x) => s + Number(x.total), 0) * 100) / 100;
const rb = (b: Body) => Object.fromEntries(b.summary.filter(x => Number(x.total) !== 0).map(x => [x.bucket, Math.round(Number(x.total) * 100) / 100]));
const F: Record<string, keyof AgingBucket> = { current: 'current', '1-30': 'days30', '31-60': 'days60', '61-90': 'days90', '90+': 'days120Plus' };
const svcTotal = (bs: AgingBucket[]) => Math.round(bs.reduce((s, b) => s + b.total, 0) * 100) / 100;
function sb(bs: AgingBucket[]) { const o: Record<string, number> = {}; for (const [l, f] of Object.entries(F)) { const v = bs.reduce((s, b) => s + Number(b[f] ?? 0), 0); if (v !== 0) o[l] = Math.round(v * 100) / 100; } return o; }

async function arInv(n: string, date: string, due: string, gross: number, paid: number, status: string) {
  return ((await sql`INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + n}, ${date}::date, ${due}::date, ${status},
      ${gross}, 0, 0, ${gross}, ${paid}, ${USER}::UUID) RETURNING id`) as { id: string }[])[0]!.id;
}
async function apInv(n: string, date: string, due: string, gross: number, paid: number, status: string) {
  return ((await sql`INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${date}::date, ${due}::date, ${status}, ${gross}, 0, ${gross},
      ${paid}, ${USER}::UUID) RETURNING id`) as { id: string }[])[0]!.id;
}
async function arPay(n: string, inv: string, amt: number, date: string, status = 'confirmed') {
  const id = ((await sql`INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date, total_amount, status, created_by)
    VALUES (${COMPANY}::UUID, ${TAG + n}, ${customer}::UUID, ${date}::date, ${amt}, ${status}, ${USER}::UUID) RETURNING id`) as { id: string }[])[0]!.id;
  await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${id}::UUID, ${inv}::UUID, ${amt})`;
}
async function apPay(n: string, inv: string, amt: number, date: string, status = 'processed') {
  const id = ((await sql`INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
    VALUES (${COMPANY}::UUID, ${TAG + n}, ${supplier}::UUID, ${date}::date, ${amt}, ${status}, ${USER}::UUID) RETURNING id`) as { id: string }[])[0]!.id;
  await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${id}::UUID, ${inv}::UUID, ${amt})`;
}
async function cn(side: 'ar' | 'ap', inv: string, amt: number, date: string, status: string, cancelledAt: string | null) {
  if (side === 'ar') {
    await sql`INSERT INTO credit_notes (company_id, type, client_id, customer_invoice_id, credit_date, subtotal, total_amount, applied_amount, status, cancelled_at, created_by)
      VALUES (${COMPANY}::UUID, 'customer', ${customer}::UUID, ${inv}::UUID, ${date}::date, ${amt}, ${amt}, ${amt}, ${status}, ${cancelledAt}::timestamptz, ${USER}::UUID)`;
  } else {
    await sql`INSERT INTO credit_notes (company_id, type, supplier_id, supplier_invoice_id, credit_date, subtotal, total_amount, applied_amount, status, cancelled_at, created_by)
      VALUES (${COMPANY}::UUID, 'supplier', ${supplier}::UUID, ${inv}::UUID, ${date}::date, ${amt}, ${amt}, ${amt}, ${status}, ${cancelledAt}::timestamptz, ${USER}::UUID)`;
  }
}

describeIfDb('R-059 ageing route == service on every day, and true at each change', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059D ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'c ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'s ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    const D0 = shift(-100), DUE = shift(-90);
    const cancelAt = `${shift(-10)} 12:00:00+02`;

    const x = await arInv('-ARX', D0, DUE, 1000, 400, 'partially_paid');
    await arPay('-ARX1', x, 300, shift(-60));
    await cn('ar', x, 100, shift(-20), 'approved', null);
    const z = await arInv('-ARZ', D0, DUE, 500, 500, 'paid');
    await sql`INSERT INTO customer_write_offs (company_id, write_off_number, client_id, invoice_id, amount, reason, write_off_date, status, created_by)
      VALUES (${COMPANY}::UUID, ${TAG + 'WO'}, ${customer}::UUID, ${z}::UUID, 500, 'bad', ${shift(-25)}::date, 'approved', ${USER}::UUID)`;
    const w = await arInv('-ARW', D0, DUE, 800, 0, 'approved');
    await cn('ar', w, 200, shift(-50), 'cancelled', cancelAt);
    await arInv('-ARV', shift(-35), shift(-35), 250, 0, 'approved');

    const ax = await apInv('-APX', D0, DUE, 1000, 400, 'partially_paid');
    await apPay('-APX1', ax, 300, shift(-60));
    await cn('ap', ax, 100, shift(-20), 'approved', null);
    const aw = await apInv('-APW', D0, DUE, 800, 0, 'approved');
    await cn('ap', aw, 200, shift(-50), 'cancelled', cancelAt);
    await apInv('-APV', shift(-35), shift(-35), 250, 0, 'approved');

    token = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM customer_write_offs WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  const SIDES = [
    { name: 'AR', route: arAgingRoute, service: getARAging,
      truth: { [-101]: 0, [-100]: 2300, [-60]: 2000, [-50]: 1800, [-35]: 2050, [-25]: 1550, [-20]: 1450, [-11]: 1450, [-9]: 1650, 0: 1650 } as Record<number, number> },
    { name: 'AP', route: apAgingRoute, service: getAPAging,
      truth: { [-101]: 0, [-100]: 1800, [-60]: 1500, [-50]: 1300, [-35]: 1550, [-20]: 1450, [-11]: 1450, [-9]: 1650, 0: 1650 } as Record<number, number> },
  ] as const;

  for (const side of SIDES) {
    it(`${side.name}: route == service (total and buckets) and rows == summary, every day −105..today`, async () => {
      const mismatches: string[] = [];
      for (let d = -105; d <= 0; d++) {
        const at = shift(d);
        const body = await callRoute(side.route, at);
        const s = await side.service(COMPANY, at);
        const r = { t: total(body), b: rb(body) };
        const v = { t: svcTotal(s), b: sb(s) };
        if (JSON.stringify(r) !== JSON.stringify(v)) mismatches.push(`${d}: route ${JSON.stringify(r)} service ${JSON.stringify(v)}`);
        const rows = Math.round(body.rows.reduce((acc, x) => acc + Number(x.balance_due), 0) * 100) / 100;
        if (rows !== r.t) mismatches.push(`${d}: rows ${rows} summary ${r.t}`);
      }
      expect(mismatches).toEqual([]);
    }, 300000);

    it(`${side.name}: the figure is the true balance on each day that changes it`, async () => {
      const got: Record<number, number> = {};
      for (const d of Object.keys(side.truth).map(Number)) got[d] = total(await callRoute(side.route, shift(d)));
      expect(got).toEqual(side.truth);
    }, 120000);
  }
});
