/**
 * `moveSupplierBillPaid` (2026-10-25) replaced the AP apply / unapply pair "UPDATE amount_paid, then
 * recomputeInvoiceStatus" with ONE statement, so a bill is written once per transaction (a second write re-ran its
 * supplier FK check after the payment lock and crossed a supplier merge, 40P01).
 *
 * DIFFERENTIAL, over real Postgres: for every status the table allows (NULL included) and every money shape (part
 * and full application, the one-cent tolerance, unapply to zero and part-way, a NULL amount_paid, a stored paid_at
 * that must survive), two identical bills are moved in ONE transaction — one by the old pair, one by the new
 * statement — and every derived column must agree. One transaction, so NOW() is the same instant for both.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { moveSupplierBillPaid, recomputeInvoiceStatus } from '@/modules/accounting/services/ar/invoiceStatusRecompute';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let fx: K074Fixture;

beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => { try { await cleanupK074(pool, fx); } finally { await pool.end(); } });

const STATUSES = [null, 'draft', 'pending_approval', 'approved', 'partially_paid', 'paid', 'disputed', 'cancelled'];

interface Shape { name: string; total: number; paid: number | null; delta: number; settled?: boolean }
const SHAPES: Shape[] = [
  { name: 'part application', total: 1000, paid: 0, delta: 300 },
  { name: 'application to full', total: 1000, paid: 700, delta: 300 },
  { name: 'within the one-cent tolerance', total: 1000, paid: 999.98, delta: 0.01 },
  { name: 'one cent applied', total: 1000, paid: 0, delta: 0.01 },
  { name: 'application on a NULL amount_paid', total: 1000, paid: null, delta: 200 },
  { name: 'unapply to zero', total: 1000, paid: 1000, delta: -1000, settled: true },
  { name: 'unapply part-way', total: 1000, paid: 1000, delta: -400, settled: true },
  { name: 'application to an already-settled bill keeps its dates', total: 1000, paid: 1000, delta: 0, settled: true },
];

async function bill(status: string | null, s: Shape): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,subtotal,tax_amount,
       total_amount,amount_paid,status,created_by,paid_at,payment_matched,payment_matched_at)
     VALUES($1,$2,$3,$4,$5::DATE,$5::DATE + 30,$6,0,$6,$7,$8,$9,$10,$11,$12)`,
    [id, fx.company, fx.supplier, `SW-${id.slice(0, 8)}`, DAY, s.total, s.paid, status, fx.user,
      s.settled ? '2026-01-02T03:04:05Z' : null, s.settled === true, s.settled ? '2026-01-02T03:04:05Z' : null]);
  return id;
}

const COLUMNS = 'status, amount_paid::TEXT AS amount_paid, paid_at, payment_matched, payment_matched_at';

describe('moveSupplierBillPaid agrees with amount_paid + recomputeInvoiceStatus', () => {
  for (const status of STATUSES) {
    for (const shape of SHAPES) {
      it(`${status ?? 'NULL'}: ${shape.name}`, async () => {
        const oldWay = await bill(status, shape);
        const newWay = await bill(status, shape);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const rows = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} } as never, async () => {
            await sql`
              UPDATE supplier_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${shape.delta}, updated_at = NOW()
              WHERE id = ${oldWay}::UUID AND company_id = ${fx.company}::UUID`;
            await recomputeInvoiceStatus(fx.company, 'supplier', oldWay);
            expect(await moveSupplierBillPaid(fx.company, newWay, shape.delta)).toBe(true);
            return (await client.query(
              `SELECT id, ${COLUMNS} FROM supplier_invoices WHERE id = ANY($1::UUID[])`, [[oldWay, newWay]])).rows;
          });
          await client.query('ROLLBACK');
          const pick = (id: string) => {
            const { id: _id, ...rest } = rows.find((r) => r.id === id)!;
            return rest;
          };
          expect(pick(newWay)).toEqual(pick(oldWay));
        } finally { client.release(); }
      }, 30_000);
    }
  }

  it('the unapply floor: refuses (writes nothing) when amount_paid is below it', async () => {
    const id = await bill('paid', { name: '', total: 1000, paid: 300, delta: 0 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const moved = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} } as never,
        () => moveSupplierBillPaid(fx.company, id, -400, 400));
      const after = (await client.query('SELECT amount_paid::TEXT AS p FROM supplier_invoices WHERE id = $1', [id])).rows[0];
      await client.query('ROLLBACK');
      expect({ moved, after: after.p }).toEqual({ moved: false, after: '300.00' });
    } finally { client.release(); }
  }, 30_000);

  it('is company-scoped: another tenant\'s id moves nothing', async () => {
    const id = await bill('approved', { name: '', total: 1000, paid: 0, delta: 0 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const moved = await als.run({ client, userId: fx.user, companyId: fx.otherCompany, claims: {} } as never,
        () => moveSupplierBillPaid(fx.otherCompany, id, 100));
      await client.query('ROLLBACK');
      expect(moved).toBe(false);
    } finally { client.release(); }
  }, 30_000);
});
