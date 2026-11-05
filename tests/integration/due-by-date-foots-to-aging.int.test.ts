// tests/integration/due-by-date-foots-to-aging.int.test.ts
//
// The "Due by date" report is built from the aging's own open-document queries,
// and its promise is that overdue now + due today to date + due later + no due
// date equals the aged total, to the cent, per contact and in all. Seeded here:
// every column (including a due date of exactly today and exactly by_date), a
// document with NO due date (the aging ages it from its invoice date; this
// report must not), a part-paid invoice, a disputed invoice (held out of the
// aging total, so held out here), an unallocated credit note (negative, dropped
// by the aging), and a second tenant's debt.
//
// The service is called directly: auth and the route's JSON are not under test,
// the SQL and the footing are.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import {
  appToday,
  DueByDateInputError,
  getDueByDate,
  getDueByDateContact,
  getDueByDateReport,
} from '@/modules/accounting/services/reports/dueByDateService';
import type { DueByDateSide } from '@/modules/accounting/utils/dueByDate';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const USER = randomUUID();
const TAG = `DBD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TODAY = appToday();

/** TODAY shifted by `days`, by calendar arithmetic on the date string. */
function shift(days: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const BY = shift(20);

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const cents = (n: number) => Math.round(n * 100);

let customer = '';
let supplier = '';
let otherCustomer = '';

async function party(pool: Pool, table: 'customers' | 'suppliers', co: string, name: string): Promise<string> {
  const r = await pool.query(`INSERT INTO ${table} (company_id, name) VALUES ($1,$2) RETURNING id`, [co, name]);
  return r.rows[0].id as string;
}

/** due === null stores a NULL due_date. */
async function arInvoice(pool: Pool, co: string, cust: string, tag: string, due: string | null, total: number, paid = 0): Promise<string> {
  const r = await pool.query(
    `INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
       status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$2,$3,$4::date,$5::date,'approved',$6,$7,$8) RETURNING id`,
    [co, cust, `${TAG}-AR-${tag}`, shift(-60), due, total, paid, USER],
  );
  return r.rows[0].id as string;
}

async function apInvoice(pool: Pool, co: string, supp: string, tag: string, due: string | null, total: number, paid = 0): Promise<void> {
  await pool.query(
    `INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
       status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$3,$4::date,$5::date,'approved',$6,$7,$8)`,
    [co, supp, `${TAG}-AP-${tag}`, shift(-60), due, total, paid, USER],
  );
}

function agingTotal(buckets: AgingBucket[]): number {
  return sum(buckets.map((b) => b.total));
}

function columns(side: DueByDateSide) {
  const t = side.totals;
  return t.overdueNow + t.dueTodayToDate + t.dueLater + t.noDueDate;
}

describeIfDb('Due by date foots to the AR / AP aging', () => {
  let pool: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company, customer, supplier and invoice fixtures.');
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1,$2,'admin',true)`, [USER, `${USER}@test.local`]);
    for (const [id, name] of [[A, 'Due by date A'], [B, 'Due by date B']] as const) {
      await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1,$2,true)`, [id, `${name} ${TAG}`]);
    }
    customer = await party(pool, 'customers', A, `cust ${TAG}`);
    supplier = await party(pool, 'suppliers', A, `supp ${TAG}`);
    otherCustomer = await party(pool, 'customers', B, `other ${TAG}`);

    // AR: 600 overdue after a part payment (1000 - 400), 250 due today, 333.33
    // due exactly on BY, 444.44 later, 555.55 with no due date, 500 disputed
    // 300 of 800 and overdue.
    await arInvoice(pool, A, customer, 'OVER', shift(-10), 1000, 400);
    await arInvoice(pool, A, customer, 'TODAY', TODAY, 250);
    await arInvoice(pool, A, customer, 'BYDATE', BY, 333.33);
    await arInvoice(pool, A, customer, 'LATER', shift(40), 444.44);
    await arInvoice(pool, A, customer, 'NODUE', null, 555.55);
    const disputed = await arInvoice(pool, A, customer, 'DISP', shift(-5), 800);
    await pool.query(
      `INSERT INTO customer_invoice_disputes (company_id, customer_invoice_id, reason, raised_by, disputed_amount)
       VALUES ($1,$2,'fixture',$3,300)`, [A, disputed, USER]);
    await pool.query(
      `INSERT INTO credit_notes (company_id, client_id, credit_note_number, credit_date, type, status, total_amount, applied_amount, created_by)
       VALUES ($1,$2,$3,$4::date,'customer','approved',100,0,$5)`, [A, customer, `CN-${TAG.slice(-9)}`, shift(-3), USER]);
    await arInvoice(pool, B, otherCustomer, 'OTHER', shift(-30), 9999);

    // AP
    await apInvoice(pool, A, supplier, 'OVER', shift(-20), 1200, 200);
    await apInvoice(pool, A, supplier, 'BYDATE', BY, 70.07);
    await apInvoice(pool, A, supplier, 'LATER', shift(90), 80.08);
    await apInvoice(pool, A, supplier, 'NODUE', null, 123.45);
  }, 60000);

  afterAll(async () => {
    if (!pool) return;
    for (const co of [A, B]) {
      await pool.query('DELETE FROM customer_invoice_disputes WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM credit_notes WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM customer_invoices WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM customers WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM suppliers WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM companies WHERE id = $1', [co]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.end();
  }, 60000);

  it('AR columns hold exactly the seeded amounts', async () => {
    const ar = await getDueByDate(A, 'ar', BY);
    expect(ar.totals).toMatchObject({
      overdueNow: 600 + 500,
      dueTodayToDate: 583.33,
      totalByDate: 1683.33,
      dueLater: 444.44,
      noDueDate: 555.55,
      disputed: 300,
    });
    expect(ar.contacts).toHaveLength(1);
    expect(ar.contacts[0]!.invoices.find((i) => i.invoiceNumber.endsWith('-NODUE'))).toMatchObject({ dueDate: null, bucket: 'noDueDate' });
  });

  it('AR: the four columns plus the dispute held apart equal the aging total (disputes included), in all and for the contact', async () => {
    const ar = await getDueByDate(A, 'ar', BY);
    const aging = await getARAging(A);
    expect(cents(columns(ar)) + cents(ar.totals.disputed)).toBe(cents(agingTotal(aging)));
    expect(cents(ar.totals.total)).toBe(cents(agingTotal(aging)));
    const agedContact = aging.find((b) => b.entityId === customer)!;
    expect(cents(ar.contacts[0]!.total)).toBe(cents(agedContact.total));
    expect(cents(ar.contacts[0]!.disputed)).toBe(cents(agedContact.disputed ?? 0));
  });

  it('AP: the four columns equal the aging total, and no-due-date stays out of the dated columns', async () => {
    const ap = await getDueByDate(A, 'ap', BY);
    const aging = await getAPAging(A);
    expect(cents(columns(ap))).toBe(cents(agingTotal(aging)));
    expect(ap.totals).toMatchObject({ overdueNow: 1000, dueTodayToDate: 70.07, dueLater: 80.08, noDueDate: 123.45 });
    // The aging ages the undated bill from its invoice date (60 days overdue), so it sits
    // in the aging total; overdueNow staying at 1000 shows this report did not do that.
  });

  it('both sides plus the net position (receivables less payables, total by date)', async () => {
    const r = await getDueByDateReport(A, BY);
    expect(r.today).toBe(TODAY);
    expect(r.netPosition).toBeCloseTo(r.ar.totals.totalByDate - r.ap.totals.totalByDate, 2);
    expect(r.netPosition).toBeCloseTo((1100 + 583.33) - (1000 + 70.07), 2);
  });

  it('a window of one day (by_date = today) moves the by-date document into later', async () => {
    const ar = await getDueByDate(A, 'ar', TODAY);
    expect(ar.totals.dueTodayToDate).toBe(250);
    expect(ar.totals.dueLater).toBe(777.77);
    expect(cents(columns(ar)) + cents(ar.totals.disputed)).toBe(cents(agingTotal(await getARAging(A))));
  });

  it("never reads another tenant's documents", async () => {
    const ar = await getDueByDate(A, 'ar', BY);
    expect(JSON.stringify(ar)).not.toContain('9999');
    const other = await getDueByDate(B, 'ar', BY);
    expect(other.totals.overdueNow).toBe(9999);
    expect(other.totals.total).toBe(9999);
  });

  it('a contact drill-down read in SQL equals that contact in the whole-side read, and is null for anyone else', async () => {
    for (const [side, id] of [['ar', customer], ['ap', supplier]] as const) {
      const whole = (await getDueByDate(A, side, BY)).contacts.find((c) => c.contactId === id)!;
      const one = await getDueByDateContact(A, side, BY, id);
      expect(one).toEqual(whole);
      expect(one!.invoices.length).toBeGreaterThan(1);
    }
    // another tenant's customer, and a contact of this company on the wrong side
    expect(await getDueByDateContact(A, 'ar', BY, otherCustomer)).toBeNull();
    expect(await getDueByDateContact(A, 'ap', BY, customer)).toBeNull();
    expect(await getDueByDateContact(B, 'ar', BY, customer)).toBeNull();
  });

  it('refuses a by_date in the past', async () => {
    await expect(getDueByDate(A, 'ar', shift(-1))).rejects.toBeInstanceOf(DueByDateInputError);
  });
});
