// tests/integration/dashboard-aging-ties-to-report.int.test.ts
//
// The dashboard's AR/AP ageing donuts used to re-aggregate the ledger on their
// own: four buckets whose "90+" was really "> 60", their own status list, no
// disputes, and CURRENT_DATE (the UTC session date, the previous day in SAST
// for two hours every night). On Demo that put R 10 699 420.43 in "90+" while
// the aging report said R 10 686 885.43.
//
// getAgingBreakdown now returns the aging services' own buckets summed over
// every customer / supplier. These tests seed invoices in every bucket, on
// every boundary (60, 61, 90 and 91 days overdue), plus a disputed invoice, one
// settled by a post-dated receipt, and a second tenant's noise, and assert the
// dashboard equals the report to the cent — by day and just after midnight SAST.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getAgingBreakdown } from '@/modules/accounting/services/reports/kpiChartsService';
import { todayInSast } from '@/lib/saDateParser';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = '00000000-0000-0000-0000-0000000d0a01';
const CUSTOMER = '00000000-0000-0000-0000-0000000d0a02';
const SUPPLIER = '00000000-0000-0000-0000-0000000d0a03';
const BANK = '00000000-0000-0000-0000-0000000d0a04';
const OTHER = '00000000-0000-0000-0000-0000000d0b01';
const OTHER_CUSTOMER = '00000000-0000-0000-0000-0000000d0b02';
const OTHER_SUPPLIER = '00000000-0000-0000-0000-0000000d0b03';

const TODAY = todayInSast();
/** TODAY shifted by `days`, by calendar arithmetic on the date string. */
function shift(days: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** [days overdue, amount]. Every amount is distinct so a misplaced one shows. */
const OPEN: [number, number][] = [
  [-5, 101.01], [10, 202.02], [45, 303.03], [60, 404.04],
  [61, 505.05], [75, 606.06], [90, 707.07], [91, 808.08], [120, 909.09],
];
const DISPUTED_FACE = 1000;
const DISPUTED_PART = 250;
const SETTLED_LATER = 5555;
const NOISE = 77777;

const LABELS = ['Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days'];
/** By hand from OPEN, so a change to the services' bucketing is also caught. */
const EXPECTED_AR = [101.01, 202.02, 303.03 + 404.04, 505.05 + 606.06 + 707.07, 808.08 + 909.09 + (DISPUTED_FACE - DISPUTED_PART)];
const EXPECTED_AP = [101.01, 202.02, 303.03 + 404.04, 505.05 + 606.06 + 707.07, 808.08 + 909.09];

function summed(rows: AgingBucket[]): number[] {
  const keys = ['current', 'days30', 'days60', 'days90', 'days120Plus'] as const;
  return keys.map((k) => rows.reduce((s, r) => s + r[k], 0));
}

async function expectTie(): Promise<void> {
  const ar = await getAgingBreakdown(COMPANY, 'ar');
  const ap = await getAgingBreakdown(COMPANY, 'ap');
  expect(ar.map((b) => b.name)).toEqual(LABELS);
  expect(ap.map((b) => b.name)).toEqual(LABELS);
  const reportAr = summed(await getARAging(COMPANY, todayInSast()));
  const reportAp = summed(await getAPAging(COMPANY, todayInSast()));
  ar.forEach((b, i) => {
    expect(b.value).toBeCloseTo(reportAr[i]!, 2);
    expect(b.value).toBeCloseTo(EXPECTED_AR[i]!, 2);
  });
  ap.forEach((b, i) => {
    expect(b.value).toBeCloseTo(reportAp[i]!, 2);
    expect(b.value).toBeCloseTo(EXPECTED_AP[i]!, 2);
  });
}

describeIfDb('dashboard ageing equals the AR/AP aging report', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);
    for (const [co, cust, supp] of [[COMPANY, CUSTOMER, SUPPLIER], [OTHER, OTHER_CUSTOMER, OTHER_SUPPLIER]]) {
      await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, 'Dash Aging Fixture', true)`, [co]);
      await admin.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Dash Aging Customer')`, [cust, co]);
      await admin.query(`INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, 'Dash Aging Supplier')`, [supp, co]);
    }
    await admin.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES ($1, $2, 'DA1000', 'Bank', 'asset', 'bank', 'debit', true)`, [BANK, COMPANY]);

    for (const [i, [days, amount]] of OPEN.entries()) {
      await invoice(admin, COMPANY, CUSTOMER, `DA-AR-${i}`, shift(-days - 30), shift(-days), amount, 0, 'approved');
      await bill(admin, COMPANY, SUPPLIER, `DA-AP-${i}`, shift(-days - 30), shift(-days), amount, 0, 'approved');
    }
    const disputed = await invoice(admin, COMPANY, CUSTOMER, 'DA-AR-D', shift(-150), shift(-120), DISPUTED_FACE, 0, 'approved');
    await admin.query(
      `INSERT INTO customer_invoice_disputes (company_id, customer_invoice_id, reason, raised_by, disputed_amount)
       VALUES ($1, $2, 'fixture', $3, $4)`, [COMPANY, disputed, COMPANY, DISPUTED_PART]);
    // Settled by a receipt dated after the as-at: settled now, never rewound.
    const settled = await invoice(admin, COMPANY, CUSTOMER, 'DA-AR-S', shift(-100), shift(-70), SETTLED_LATER, SETTLED_LATER, 'paid');
    const { rows } = await admin.query(
      `INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
       VALUES ($1, $2, 'DA-R1', $3, $4, 'confirmed', $5, $6) RETURNING id`,
      [COMPANY, CUSTOMER, shift(1), SETTLED_LATER, BANK, COMPANY]);
    await admin.query(
      `INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated) VALUES ($1, $2, $3)`,
      [rows[0].id, settled, SETTLED_LATER]);
    // The other tenant's debt, in every bucket's reach.
    await invoice(admin, OTHER, OTHER_CUSTOMER, 'DA-AR-X', shift(-200), shift(-75), NOISE, 0, 'approved');
    await bill(admin, OTHER, OTHER_SUPPLIER, 'DA-AP-X', shift(-200), shift(-75), NOISE, 0, 'approved');
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('every bucket equals the aging services summed per bucket, to the cent', async () => {
    await expectTie();
  });

  it('61–90 is its own bucket and not inside 90+', async () => {
    const ar = await getAgingBreakdown(COMPANY, 'ar');
    expect(ar[3]!.value).toBeCloseTo(505.05 + 606.06 + 707.07, 2);
    expect(ar[4]!.value).toBeCloseTo(EXPECTED_AR[4]!, 2);
  });

  it("never counts another tenant's invoices", async () => {
    for (const side of ['ar', 'ap'] as const) {
      const total = (await getAgingBreakdown(COMPANY, side)).reduce((s, b) => s + b.value, 0);
      expect(total).toBeLessThan(NOISE);
    }
    const other = await getAgingBreakdown(OTHER, 'ar');
    expect(other[3]!.value).toBeCloseTo(NOISE, 2);
  });

  it('just after midnight SAST (22:30 UTC the day before) it still ages from the SAST day', async () => {
    // TODAY 00:30 SAST is the previous UTC day. CURRENT_DATE or a UTC date
    // would age every boundary invoice one day younger: 61 → 31–60, 91 → 61–90.
    const prevUtcDay = shift(-1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${prevUtcDay}T22:30:00Z`));
    try {
      expect(todayInSast()).toBe(TODAY);
      await expectTie();
    } finally {
      vi.useRealTimers();
    }
  });
});

async function invoice(
  admin: Pool, co: string, cust: string, number: string, invoiceDate: string, dueDate: string,
  total: number, paid: number, status: string,
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO customer_invoices
       (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [co, cust, number, invoiceDate, dueDate, status, total, paid, co]);
  return rows[0].id as string;
}

async function bill(
  admin: Pool, co: string, supp: string, number: string, invoiceDate: string, dueDate: string,
  total: number, paid: number, status: string,
): Promise<void> {
  await admin.query(
    `INSERT INTO supplier_invoices
       (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [co, supp, number, invoiceDate, dueDate, status, total, paid, co]);
}

async function cleanup(admin: Pool): Promise<void> {
  for (const co of [COMPANY, OTHER]) {
    await admin.query(`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = $1)`, [co]);
    await admin.query('DELETE FROM customer_payments WHERE company_id = $1', [co]);
    await admin.query('DELETE FROM customer_invoice_disputes WHERE company_id = $1', [co]);
    await admin.query('DELETE FROM customer_invoices WHERE company_id = $1', [co]);
    await admin.query('DELETE FROM supplier_invoices WHERE company_id = $1', [co]);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [co]);
    await admin.query('DELETE FROM customers WHERE company_id = $1', [co]);
    await admin.query('DELETE FROM suppliers WHERE company_id = $1', [co]);
    await admin.query('DELETE FROM companies WHERE id = $1', [co]);
  }
}
