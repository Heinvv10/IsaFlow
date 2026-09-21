// tests/integration/k064-cancel-payment.int.test.ts
//
// Cancel, ALONGSIDE Void, on supplier-payments-action. Cancel is for money that
// never moved (draft / approved): it posts nothing and releases the payment's
// reservation on its bills. It refuses a processed payment and points at Void,
// which reverses the journal — a processed payment is never "cancelled" with
// its journal left behind. It is gated exactly as Void is (the same route, the
// same `withWriteAccess`), company-scoped, and serialises with Process on the
// payment row lock, so a cancel racing a process has exactly one outcome.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill, billState } from './ap-allocation-guards.helpers';
import { flow, text, type State } from './ap-payment-flow.helpers';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-064 — Cancel an unprocessed supplier payment', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (sql: string, p: unknown[]) => fx.pool.query(sql, p);
  const approved = () => bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
  const VIEWER = randomUUID();
  let viewerToken = '';

  /** supplier-payments-action as a company-A member holding `viewer`. */
  async function asViewer(action: string, paymentId: string): Promise<State> {
    const req = request({ 'sb-access-token': viewerToken, active_company_id: ids.A }, 'POST') as never as
      { body: unknown; url: string };
    req.body = { action, paymentId };
    req.url = '/api/accounting/k064-cancel-fixture';
    const out = response();
    await supplierPaymentsAction(req as never, out.res as never);
    return out.state;
  }
  const journalRow = async (paymentId: string) => (await q(
    'SELECT status, gl_journal_entry_id FROM supplier_payments WHERE id = $1', [paymentId])).rows[0];
  const journalsNaming = async (paymentId: string) => Number((await q(
    `SELECT count(*) AS n FROM gl_journal_entries je JOIN supplier_payments sp ON sp.id = $1
     WHERE je.company_id = $2 AND je.description = 'Supplier payment ' || sp.payment_number`,
    [paymentId, ids.A])).rows[0].n);

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064 cancel');
    await q("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)", [VIEWER, `k064-v-${VIEWER}@isaflow.test`]);
    await q("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')", [ids.A, VIEWER]);
    viewerToken = await new SignJWT({ sub: VIEWER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });
  afterAll(async () => {
    await fx?.pool.query('DELETE FROM company_users WHERE user_id = $1', [VIEWER]);
    await fx?.pool.query('DELETE FROM users WHERE id = $1', [VIEWER]);
    await tearDownFixture(fx?.pool);
  });

  it('cancels an APPROVED payment: nothing posted, and the bill is free again', async () => {
    const b = await approved();
    const paymentId = await f.approvedPayment(b, 1000);
    const ap = await f.apDebits();

    const state = await f.paymentAction('cancel', paymentId);

    expect(state.statusCode, text(state)).toBe(200);
    expect(await journalRow(paymentId)).toEqual({ status: 'cancelled', gl_journal_entry_id: null });
    expect(await journalsNaming(paymentId)).toBe(0);
    expect(await f.apDebits()).toBe(ap);
    expect(await billState(fx.pool, b)).toEqual({ paid: 0, status: 'approved' });
    // Released: the full 1000 can be promised again.
    expect((await f.createBatch([{ billId: b, amount: 1000 }])).statusCode).toBe(200);
  });

  it('cancels a DRAFT payment', async () => {
    const made = await f.createPayment(await approved(), 500);
    const paymentId = f.idOf(made);
    expect((await f.paymentAction('cancel', paymentId)).statusCode).toBe(200);
    expect((await journalRow(paymentId)).status).toBe('cancelled');
  });

  it('refuses a PROCESSED payment with a 400 pointing to Void, and leaves its journal standing', async () => {
    const b = await approved();
    const paymentId = await f.approvedPayment(b, 1000);
    expect((await f.paymentAction('process', paymentId)).statusCode).toBe(200);
    const before = await journalRow(paymentId);

    const state = await f.paymentAction('cancel', paymentId);

    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('Use Void, which reverses it');
    expect(await journalRow(paymentId)).toEqual(before);
    expect(before.status).toBe('processed');
    expect(await billState(fx.pool, b)).toEqual({ paid: 1000, status: 'paid' });
  });

  it('is gated exactly as Void: a viewer is refused both, and nothing changes', async () => {
    const paymentId = await f.approvedPayment(await approved(), 1000);
    const cancel = await asViewer('cancel', paymentId);
    const voided = await asViewer('void', paymentId);
    expect(cancel.statusCode, text(cancel)).toBe(403);
    expect(voided.statusCode, text(voided)).toBe(403);
    expect((await journalRow(paymentId)).status).toBe('approved');
  });

  it('is company-scoped: another company\'s payment id is not found, and is untouched', async () => {
    const foreign = randomUUID();
    await q(`INSERT INTO supplier_payments (id, company_id, supplier_id, payment_number, payment_date, total_amount,
      payment_method, status, created_by) VALUES ($1, $2, $3, $4, CURRENT_DATE, 10, 'eft', 'approved', $5)`,
    [foreign, ids.B, ids.SUP_B, `K064-B-${foreign.slice(0, 8)}`, ids.USER]);
    const state = await f.paymentAction('cancel', foreign);
    expect(state.statusCode, text(state)).toBe(404);
    expect((await journalRow(foreign)).status).toBe('approved');
  });

  it('cancel racing process: exactly one outcome, never an orphaned journal (6 trials)', async () => {
    for (let trial = 0; trial < 6; trial++) {
      const b = await approved();
      const paymentId = await f.approvedPayment(b, 1000);
      const ap = await f.apDebits();
      const pair = [() => f.paymentAction('process', paymentId), () => f.paymentAction('cancel', paymentId)];
      const [first, second] = trial % 2 ? [pair[1]!, pair[0]!] : [pair[0]!, pair[1]!];
      const [r1, r2] = await Promise.all([first(), second()]);

      const ok = [r1, r2].filter((r) => r.statusCode === 200);
      expect(ok.length, `${text(r1)} / ${text(r2)}`).toBe(1);
      for (const r of [r1, r2]) expect(r.statusCode, text(r)).toBeLessThan(500);
      const row = await journalRow(paymentId);
      if (row.status === 'processed') {
        expect(row.gl_journal_entry_id).not.toBeNull();
        expect(await journalsNaming(paymentId)).toBe(1);
        expect(await f.apDebits()).toBe(ap + 1000);
        expect((await billState(fx.pool, b)).paid).toBe(1000);
      } else {
        expect(row).toEqual({ status: 'cancelled', gl_journal_entry_id: null });
        expect(await journalsNaming(paymentId)).toBe(0);
        expect(await f.apDebits()).toBe(ap);
        expect((await billState(fx.pool, b)).paid).toBe(0);
      }
    }
  }, 60000);
});
