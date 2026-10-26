/**
 * Void after refund, the batch-reversal arm (`ap/batchPaymentReversal`, Hein's ruling 2026-10-26): reversing a
 * processed batch cancels every member, so it is refused when the members' unapplied remainders TOGETHER would take
 * the supplier's on-account credit below zero — judged per supplier over the whole batch, not member by member.
 *
 * A batch member is normally applied in full (it lowers nothing). The remainders here are planted by hand — each
 * member's total raised by R300 above what it applies — because that is the only way to make the batch-level sum
 * observable: R350 of credit covers either member alone and not both. Through the real batch routes otherwise.
 * Disposable auth fixture only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { reverseBatch } from '@/modules/accounting/services/ap/batchPaymentReversal';
import { getSupplierOnAccountCredit } from '@/modules/accounting/services/ap/supplierOnAccountCredit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill } from './ap-allocation-guards.helpers';
import { flow, text } from './ap-payment-flow.helpers';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('void after refund — batch reversal', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);

  async function runTx<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string | undefined }> {
    const cl: PoolClient = await fx.pool.connect();
    await cl.query('BEGIN');
    try {
      const value = await als.run({ client: cl, userId: ids.USER, companyId: ids.A, claims: {} } as never, fn);
      await cl.query('COMMIT');
      return { ok: true, value };
    } catch (err) {
      await cl.query('ROLLBACK').catch(() => undefined);
      return { ok: false, code: (err as { code?: string }).code };
    } finally { cl.release(); }
  }
  const credit = async () => {
    const r = await runTx(() => getSupplierOnAccountCredit(ids.A, ids.SUP_A, null));
    if (!r.ok) throw new Error('credit read failed');
    return r.value.credit;
  };
  const cash = (amount: number, method: string) => q(
    `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,reference,status,created_by)
     VALUES($1,$2,CURRENT_DATE,$3,$4,'VAR batch','processed',$5)`, [ids.A, ids.SUP_A, amount, method, ids.USER]);

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('Void after refund batch');
    const y = new Date().getFullYear();
    await q(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, $2, 1, $3, $4, $5, 'open')`, [ids.A, `FY${y}`, y, `${y}-01-01`, `${y}-12-31`]);
  });
  afterAll(async () => { await tearDownFixture(fx?.pool); });

  it('is refused when the members together would take the supplier below zero, and passes once cash covers them', async () => {
    const b1 = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const b2 = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const batchId = await f.approvedBatch([{ billId: b1, amount: 300 }, { billId: b2, amount: 200 }]);
    const processed = await f.batchAction('process', batchId);
    expect(processed.statusCode, text(processed)).toBe(200);
    const baseline = await credit();
    // Each member R300 above what it applies (planted), and a refund of R250 of that: R350 still on account.
    await q(`UPDATE supplier_payments SET total_amount = total_amount + 300 WHERE batch_id = $1 AND company_id = $2`, [batchId, ids.A]);
    await cash(-250, 'refund');
    expect(await credit()).toBe(baseline + 350);

    const refused = await runTx(() => reverseBatch(ids.A, batchId, ids.USER));
    const statuses = (await q(`SELECT DISTINCT status FROM supplier_payments WHERE batch_id = $1`, [batchId])).rows.map((r) => r.status);
    expect({ refused: refused.ok ? 'passed' : refused.code, statuses }).toEqual({ refused: 'SUPPLIER_PAYMENT_REFUSED', statuses: ['processed'] });

    await cash(250, 'eft'); // R600 on account now: both remainders covered
    const passed = await runTx(() => reverseBatch(ids.A, batchId, ids.USER));
    expect({ passed: passed.ok ? 'passed' : passed.code, credit: await credit() }).toEqual({ passed: 'passed', credit: baseline });
  }, 60_000);
});
