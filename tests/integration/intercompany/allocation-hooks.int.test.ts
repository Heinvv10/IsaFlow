/**
 * Intercompany P4-B: the hook (`mirrorAllocations`) is best effort on the caller's transaction, and the three sites that apply a payer's
 * cash to a bill (the apply service, processing a payment, processing a batch) each leave the allocation message. A failure of the
 * definer is logged by SQLSTATE and never fails or poisons the payment.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { mirrorAllocations } from '../../../src/modules/accounting/services/intercompany/allocationOutbox';
import { applySupplierPaymentPlan, planSupplierPaymentApplication } from '../../../src/modules/accounting/services/ap/supplierPaymentApplicationService';
import { payRoutes } from '../r035-pr5.helpers';
import { acct } from './intercompany.fixture';
import { asAppUser } from './intercompany.session';
import { asService, co, mirrorCleanup, tokens, U, wipeConnections } from './mirror.helpers';
import { allocSetup, allocationMessages, bank, clearPayments, loanConnect, plantBill, plantPaid } from './allocation.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const r = payRoutes(tokens);
let conn = '';

beforeAll(async () => {
  await allocSetup(pool);
  await pool.query(`CREATE OR REPLACE FUNCTION public.ic_p4b_forced_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.kind = 'allocation' AND current_setting('ic_p4b.fail', true) = 'on' THEN RAISE EXCEPTION 'forced' USING ERRCODE = 'XX001'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER trg_aaa_ic_p4b_forced_failure BEFORE INSERT ON intercompany_messages FOR EACH ROW EXECUTE FUNCTION public.ic_p4b_forced_failure()');
}, 60000);
afterAll(async () => {
  await pool.query('DROP TRIGGER IF EXISTS trg_aaa_ic_p4b_forced_failure ON intercompany_messages');
  await pool.query('DROP FUNCTION IF EXISTS public.ic_p4b_forced_failure()');
  await clearPayments(pool);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await loanConnect(pool);
});
afterEach(() => vi.restoreAllMocks());

const reference = async (payment: string) => (await pool.query('SELECT reference FROM supplier_payments WHERE id = $1', [payment])).rows[0].reference as string;

describe('mirrorAllocations never fails or poisons the caller\'s transaction', () => {
  it('a definer that raises is logged by SQLSTATE; the writes before and after it in the same transaction commit', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { payment, allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    await asService(pool, U.b, co.B, async (q) => {
      await q.query("SET LOCAL ic_p4b.fail = 'on'");
      await q.query("UPDATE supplier_payments SET reference = 'before' WHERE id = $1", [payment]);
      await mirrorAllocations(co.B, [allocation]);
      await q.query("UPDATE supplier_payments SET description = 'after' WHERE id = $1", [payment]);
    });
    expect(await reference(payment)).toBe('before');
    expect((await pool.query('SELECT description FROM supplier_payments WHERE id = $1', [payment])).rows[0].description).toBe('after');
    expect(await allocationMessages(pool)).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('allocation'), expect.objectContaining({ code: 'XX001', companyId: co.B }), 'intercompany');
    expect(JSON.stringify(error.mock.calls)).not.toContain('forced');                // the code, not the database's text
  });

  it('one allocation failing does not stop the next: each id has its own savepoint', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const one = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const two = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    await asService(pool, U.b, co.B, async (q) => {
      await mirrorAllocations(co.B, ['not-a-uuid', one.allocation, crypto.randomUUID(), two.allocation]);
      await q.query("UPDATE supplier_payments SET description = 'after' WHERE id = $1", [one.payment]);
    });
    expect((await allocationMessages(pool)).map((m) => m.source_doc_id).sort()).toEqual([one.allocation, two.allocation].sort());
  });

  it('an id the caller just read that the definer cannot find is logged AT ERROR (always a bug), by reason only', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const missing = crypto.randomUUID();
    await asService(pool, U.b, co.B, () => mirrorAllocations(co.B, [missing]));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('allocation'), { companyId: co.B, allocationId: missing, reason: 'not_found' }, 'intercompany');
  });

  describe('a caller outside a request (no session company, no signed-in user: the categorization sweep)', () => {
    const NONE = ['no company, no claims', 'a company, no claims', 'claims, no company'] as const;
    const session = async (kind: (typeof NONE)[number], fn: (q: PoolClient) => Promise<unknown>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_user');
        if (kind !== NONE[0]) await client.query("SELECT set_config('app.current_company_id', $1, true)", [kind === NONE[1] ? co.B : '']);
        if (kind === NONE[2]) await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.b })]);
        const out = await als.run({ client, userId: U.b, companyId: co.B, claims: {} } as never, () => fn(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };

    it.each(NONE)('the definer answers no_session (not not_found) and the hook is silent, with %s', async (kind) => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
      const answer = await session(kind, async (q) => (await q.query('SELECT * FROM public.intercompany_send_for_allocation($1)', [allocation])).rows[0]);
      expect(answer).toEqual({ message_id: null, reason: 'no_session', detail: null });
      await session(kind, () => mirrorAllocations(co.B, [allocation, crypto.randomUUID()]));
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(await allocationMessages(pool)).toHaveLength(0);
    });
  });

  it('what is logged: a journal the ledger does not carry at ERROR, a viewer and an unlinked bill nowhere', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const noJournal = await plantPaid(pool, (await plantBill(pool, conn)).bill, { journal: false });
    const unlinked = await plantPaid(pool, (await plantBill(pool, conn, { link: false })).bill);
    await asService(pool, U.b, co.B, () => mirrorAllocations(co.B, [unlinked.allocation]));
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await asService(pool, U.b, co.B, () => mirrorAllocations(co.B, [noJournal.allocation]));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('allocation'), expect.objectContaining({ allocationId: noJournal.allocation, reason: 'no_journal' }), 'intercompany');
    const [errors, warns] = [error.mock.calls.length, warn.mock.calls.length];
    await asService(pool, U.avb, co.B, () => mirrorAllocations(co.B, [noJournal.allocation]));
    // (a viewer is 'forbidden': silent, a user without an intercompany write role pays bills all day: neither level moved)
    expect(error.mock.calls.length).toBe(errors);
    expect(warn.mock.calls.length).toBe(warns);
    expect(await allocationMessages(pool)).toHaveLength(0);
  });
});

describe('the three sites that apply a payer\'s cash to a bill each leave the message', () => {
  it('applySupplierPaymentPlan: a posted payment applied to two linked bills leaves two messages; an unlinked bill leaves none', async () => {
    const one = await plantBill(pool, conn);
    const two = await plantBill(pool, conn);
    const free = await plantBill(pool, conn, { link: false });
    const { payment } = await plantPaid(pool, one.bill, { amount: 3450, allocate: false });
    await asService(pool, U.b, co.B, async () => {
      const plan = await planSupplierPaymentApplication(co.B, payment, [
        { invoiceId: one.bill, amount: 1150 }, { invoiceId: two.bill, amount: 1150 }, { invoiceId: free.bill, amount: 1150 }]);
      await applySupplierPaymentPlan(co.B, plan, U.b);
    });
    const rows = (await pool.query('SELECT id, invoice_id FROM payment_allocations WHERE payment_id = $1', [payment])).rows;
    expect(rows).toHaveLength(3);
    const sent = await allocationMessages(pool);
    expect(sent.map((m) => m.source_doc_id).sort()).toEqual(rows.filter((x) => x.invoice_id !== free.bill).map((x) => x.id).sort());
    expect(sent.every((m) => m.payload.payment.id === payment)).toBe(true);
  });

  it('processSupplierPayment (approve, then process, through the route): the loan-mode clearing never reaches the apply function', async () => {
    const { bill } = await plantBill(pool, conn);
    const { payment, allocation } = await plantPaid(pool, bill, { status: 'draft' });
    expect((await r.payment(U.b, co.B, 'approve', payment)).state.statusCode).toBe(200);
    expect(await allocationMessages(pool)).toHaveLength(0);                                            // approving moves no money
    const res = await r.payment(U.b, co.B, 'process', payment);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const journal = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_payments WHERE id = $1', [payment])).rows[0].je as string;
    const rows = await allocationMessages(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_doc_id: allocation, source_journal_entry_id: journal, from_company_id: co.B, to_company_id: co.A, status: 'pending' });
    // a second process is refused (409) and writes no second message
    expect((await r.payment(U.b, co.B, 'process', payment)).state.statusCode).toBe(409);
    expect(await allocationMessages(pool)).toHaveLength(1);
  });

  it('processBatch (approve, then process, through the route): one message per member allocation, on the batch\'s journal, its bank leg named', async () => {
    // (P4-E (j).3) from B's bank: a batch paid from the payer's LOAN account on a linked bill is refused (the case below)
    const { rows: [batch] } = await pool.query(
      `INSERT INTO supplier_payment_batches(company_id, batch_date, payment_method, bank_account_id, payment_count, total_amount, created_by)
       VALUES ($1, DATE '2026-09-01', 'eft', $2, 2, 2300, $3) RETURNING id`, [co.B, bank.b, U.ab]);
    const one = await plantPaid(pool, (await plantBill(pool, conn)).bill, { status: 'draft', batch: batch.id });
    const two = await plantPaid(pool, (await plantBill(pool, conn)).bill, { status: 'draft', batch: batch.id });
    const free = await plantPaid(pool, (await plantBill(pool, conn, { link: false })).bill, { status: 'draft', batch: batch.id });
    await pool.query('UPDATE supplier_payment_batches SET payment_count = 3, total_amount = 3450 WHERE id = $1', [batch.id]);
    expect((await r.batch(U.b, co.B, 'approve', batch.id)).state.statusCode).toBe(200);
    const res = await r.batch(U.b, co.B, 'process', batch.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const journal = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_payment_batches WHERE id = $1', [batch.id])).rows[0].je as string;
    const rows = await allocationMessages(pool);
    expect(rows.map((m) => m.source_doc_id).sort()).toEqual([one.allocation, two.allocation].sort());
    expect(rows.every((m) => m.source_journal_entry_id === journal && m.payload.payment.cashLegIsLoanAccount === false)).toBe(true);
    expect(await allocationMessages(pool, free.allocation)).toHaveLength(0);
  });

  it('P4-E (j).3: a batch paid from the payer\'s LOAN account with a linked bill is refused before the posting (use Clear against the intercompany loan)', async () => {
    const { rows: [batch] } = await pool.query(
      `INSERT INTO supplier_payment_batches(company_id, batch_date, payment_method, bank_account_id, payment_count, total_amount, created_by)
       VALUES ($1, DATE '2026-09-01', 'eft', $2, 1, 1150, $3) RETURNING id`, [co.B, acct.bLoan, U.ab]);
    await plantPaid(pool, (await plantBill(pool, conn)).bill, { status: 'draft', batch: batch.id });
    expect((await r.batch(U.b, co.B, 'approve', batch.id)).state.statusCode).toBe(200);
    const res = await r.batch(U.b, co.B, 'process', batch.id);
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/use Clear against the intercompany loan/);
    expect((await pool.query('SELECT status, gl_journal_entry_id FROM supplier_payment_batches WHERE id = $1', [batch.id])).rows[0]).toMatchObject({ status: 'approved', gl_journal_entry_id: null });
    expect(await allocationMessages(pool)).toHaveLength(0);
  });

  it('a cash connection: processing still succeeds and writes no message', async () => {
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET settlement_mode = 'cash' WHERE id = $1", [conn]), true);
    const { payment } = await plantPaid(pool, (await plantBill(pool, conn)).bill, { status: 'draft' });
    await r.payment(U.b, co.B, 'approve', payment);
    expect((await r.payment(U.b, co.B, 'process', payment)).state.statusCode).toBe(200);
    expect(await allocationMessages(pool)).toHaveLength(0);
  });
});
