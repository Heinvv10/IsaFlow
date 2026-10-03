/**
 * R-186 review round 1, item 2: the realistic shape. A Paystack checkout settled through the real
 * webhook (R-181 helpers) leaves a receipt, its allocation and two journals (the receipt's and the
 * fee's) beside the invoice. With everything inside the window and a free cancelled invoice next
 * to it, the archive skips the referenced invoice and then:
 * - with no journal on the invoice (as the R-181 helper books it): fails whole on 23503
 *   customer_payments_gl_journal_entry_id_fkey. The run never archives customer_payments but
 *   deletes their journals by date: pre-existing, R-053 class, fails closed;
 * - with the invoice posted to the GL: refuses earlier with ARCHIVE_SKIPPED_INVOICE_JOURNAL.
 * Either way nothing moves.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { executeArchive } from '@/modules/accounting/services/core/archiveExecutionService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, B, type Co, SECRET, checkout, cleanup, deliver, invoice, pool, seed } from './r181-settlement.helpers';

assertDisposable();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: vi.fn(async () => { throw new Error('verify is not used by the webhook path'); }),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

/** After everything the fixture books today. */
const CUTOFF = '2999-01-01';

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  await seed(B);
  clearSystemAccountCache();
});
afterAll(async () => { vi.unstubAllEnvs(); await cleanup([A, B]); });

async function settledBeside(co: Co): Promise<{ settled: string; ref: string }> {
  const settled = await invoice(co, 'approved');
  const ref = await checkout(co, settled);
  expect((await deliver(ref, 11500, 'ZAR', { fees: 300 })).statusCode).toBe(200);
  await invoice(co, 'cancelled');
  return { settled, ref };
}

/** Runs the archive and always rolls back; returns what it threw. */
async function archiveFailure(co: Co): Promise<{ code?: string; constraint?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: co.user, companyId: co.id, claims: {} }, () => executeArchive(co.id, CUTOFF, co.user));
    return {};
  } catch (err) {
    return { code: (err as { code?: string }).code, constraint: (err as { constraint?: string }).constraint };
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const state = async (co: Co) => (await pool.query(
  `SELECT (SELECT count(*) FROM customer_invoices WHERE company_id = $1)::int AS invoices,
          (SELECT count(*) FROM gl_journal_entries WHERE company_id = $1)::int AS journals,
          (SELECT count(*) FROM customer_payments WHERE company_id = $1)::int AS receipts`, [co.id])).rows[0];

describe('R-186: a Paystack-settled invoice in the window', () => {
  it('with no journal on the invoice: fails whole on the receipt journal (R-053 class)', async () => {
    const { settled } = await settledBeside(A);
    const paid = (await pool.query('SELECT status FROM customer_invoices WHERE id = $1', [settled])).rows[0];
    expect(paid).toEqual({ status: 'paid' });
    const before = await state(A);
    expect(before).toEqual({ invoices: 2, journals: 2, receipts: 1 });

    const failure = await archiveFailure(A);

    expect(failure).toEqual({ code: '23503', constraint: 'customer_payments_gl_journal_entry_id_fkey' });
    expect(await state(A)).toEqual(before);
  }, 60000);

  it('with the invoice posted to the GL: refuses before deleting anything', async () => {
    const { settled } = await settledBeside(B);
    const journal = randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,created_by,source)
       VALUES($1,$2,$3,CURRENT_DATE,'R-186 invoice journal','posted',$4,'auto_invoice')`,
      [journal, B.id, `R186-${journal.slice(0, 8)}`, B.user]);
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [settled, journal]);
    const before = await state(B);

    const failure = await archiveFailure(B);

    expect(failure.code).toBe('ARCHIVE_SKIPPED_INVOICE_JOURNAL');
    expect(await state(B)).toEqual(before);
  }, 60000);
});
