/**
 * K-142 — RED. `fetchSupplierInvoiceCandidates`
 * (bankMatchDbQueries.ts:51-85 on origin/master) selects `si.total_amount` and
 * scores, orders and labels every candidate on it, while explicitly admitting
 * `partially_paid` bills at line 56. `supplier_invoices.amount_paid` exists and
 * is never read here.
 *
 * The customer arm of the SAME FILE (lines 104-137) does it correctly:
 * `ORDER BY ABS(ci.total_amount - ci.amount_paid - …)` and
 * `balance = total_amount - amount_paid`. So a part-paid BILL is offered against
 * its gross: a R300 payment settling the remainder of a R1,000 bill already
 * R700 paid is not recognised as an exact match, while an unrelated R1,000 bill
 * is — the operator is steered to the wrong bill.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { fetchSupplierInvoiceCandidates } from '@/modules/accounting/services/bank/bankMatchDbQueries';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;

async function candidates(absAmount: number) {
  const c = await admin.connect();
  try {
    return await als.run(
      { client: c, userId: USER, companyId: COMPANY, claims: {} } as never,
      () => fetchSupplierInvoiceCandidates(
        COMPANY, absAmount, -absAmount, '2026-03-10', 'EFT PAYMENT ACME', '', [],
      ),
    );
  } finally {
    c.release();
  }
}

describeIfDb('K-142 a part-paid bill must be matched on what is still owed', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K142 Match Fixture', true)`,
      [COMPANY]);
    const sup = await admin.query(
      `INSERT INTO suppliers (company_id, name) VALUES ($1, 'ACME Traders') RETURNING id`,
      [COMPANY]);
    const supplier = sup.rows[0].id;

    // R1,000 bill, R700 already paid — R300 outstanding.
    await admin.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, subtotal, total_amount,
          amount_paid, status, created_by)
       VALUES ($1,$2,'K142-PART','2026-03-01',1000,1000,700,'partially_paid',$3)`,
      [COMPANY, supplier, USER]);
    // An unrelated bill whose GROSS happens to equal the R1,000 above.
    await admin.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, subtotal, total_amount,
          amount_paid, status, created_by)
       VALUES ($1,$2,'K142-OTHER','2026-03-02',1000,1000,0,'approved',$3)`,
      [COMPANY, supplier, USER]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM supplier_invoices WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM suppliers WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('offers the R300 remainder as the candidate amount', async () => {
    const part = (await candidates(300)).find(c => c.label.includes('K142-PART'));
    expect(part).toBeTruthy();
    expect(part!.amount).toBeCloseTo(300, 2);
  });

  it('calls the R300 settlement an exact amount match', async () => {
    const part = (await candidates(300)).find(c => c.label.includes('K142-PART'));
    expect(part!.matchReason ?? '').toContain('Exact amount');
  });

  it('does not call a R1,000 payment an exact match for a bill with R300 left', async () => {
    const part = (await candidates(1000)).find(c => c.label.includes('K142-PART'));
    expect(part!.matchReason ?? '').not.toContain('Exact amount');
  });

  // Adjacent case: an untouched bill is still matched on its gross, which for
  // amount_paid = 0 IS the balance. The correction must not move the bills that
  // were already right.
  it('still matches an unpaid bill on its full amount', async () => {
    const other = (await candidates(1000)).find(c => c.label.includes('K142-OTHER'));
    expect(other!.amount).toBeCloseTo(1000, 2);
    expect(other!.matchReason ?? '').toContain('Exact amount');
  });

  // Adjacent case: a NULL amount_paid must read as zero, not as NaN. The
  // COALESCE in the ORDER BY and the `|| 0` in the balance are both load-bearing.
  it('treats a NULL amount_paid as nothing paid', async () => {
    await admin.query(
      `UPDATE supplier_invoices SET amount_paid = NULL
       WHERE company_id = $1 AND invoice_number = 'K142-OTHER'`, [COMPANY]);
    try {
      const other = (await candidates(1000)).find(c => c.label.includes('K142-OTHER'));
      expect(other!.amount).toBeCloseTo(1000, 2);
      expect(other!.matchReason ?? '').toContain('Exact amount');
    } finally {
      await admin.query(
        `UPDATE supplier_invoices SET amount_paid = 0
         WHERE company_id = $1 AND invoice_number = 'K142-OTHER'`, [COMPANY]);
    }
  });

  // Adjacent case: another company's bill must never surface as a candidate.
  it('never offers a bill from another company', async () => {
    const other = randomUUID();
    await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,'K142 Other Co',true)`, [other]);
    const sup = await admin.query(
      `INSERT INTO suppliers (company_id, name) VALUES ($1, 'ACME Traders') RETURNING id`, [other]);
    await admin.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, subtotal, total_amount,
          amount_paid, status, created_by)
       VALUES ($1,$2,'K142-FOREIGN','2026-03-01',300,300,0,'approved',$3)`,
      [other, sup.rows[0].id, USER]);
    try {
      const found = (await candidates(300)).find(c => c.label.includes('K142-FOREIGN'));
      expect(found).toBeUndefined();
    } finally {
      await admin.query('DELETE FROM supplier_invoices WHERE company_id = $1', [other]);
      await admin.query('DELETE FROM suppliers WHERE company_id = $1', [other]);
      await admin.query('DELETE FROM companies WHERE id = $1', [other]);
    }
  });
});
