/**
 * Intercompany F (k) L-4 / M-4 and (d) Z1: the hook (`allocationOutbox.ts`) asks D3 (allocation) FIRST and D1 (payment) only when D3 answers
 * `not_loan`, each in its own savepoint; a 23505 from the other kind is logged info `other_kind_sent`; a D1 lock timeout is log.error with
 * SQLSTATE 55P03; a failure never fails the payment. With the payer's flag off nothing is sent. Both definers take the payer journal key
 * BEFORE their link / connection shares (MED-4), so the same allocation row never carries both kinds.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { log } from '@/lib/logger';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { mirrorPaymentAllocations } from '../../../src/modules/accounting/services/intercompany/allocationOutbox';
import { asAppUser, count } from './intercompany.helpers';
import { asService, mirrorCleanup, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearPayments, plantBill, plantPaid } from './allocation.helpers';
import {
  blockedOn, cashConnect, clearReceipts, co, journalKey, openSession, paymentMessages, paymentSetup, sendAlloc, sendPay, U,
} from './payment.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let conn = '';

beforeAll(async () => {
  await paymentSetup(pool);
  await pool.query(`CREATE OR REPLACE FUNCTION public.ic_f_forced() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind = 'payment' AND current_setting('ic_f.fail', true) = 'dup' THEN RAISE EXCEPTION 'forged duplicate' USING ERRCODE = '23505'; END IF;
      IF NEW.kind = 'payment' AND current_setting('ic_f.fail', true) = 'on' THEN RAISE EXCEPTION 'forced' USING ERRCODE = 'XX001'; END IF;
      RETURN NEW;
    END $$`);
  await pool.query('CREATE TRIGGER trg_aaa_ic_f_forced BEFORE INSERT ON intercompany_messages FOR EACH ROW EXECUTE FUNCTION public.ic_f_forced()');
}, 60000);
afterAll(async () => {
  await pool.query('DROP TRIGGER IF EXISTS trg_aaa_ic_f_forced ON intercompany_messages');
  await pool.query('DROP FUNCTION IF EXISTS public.ic_f_forced()');
  await clearReceipts(pool);
  await clearPayments(pool);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await clearReceipts(pool);
  await clearPayments(pool);
  await wipeConnections(pool);
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  conn = await cashConnect(pool);
});
afterEach(() => vi.restoreAllMocks());

const hook = (payment: string, setup?: string) => asService(pool, U.b, co.B, async (q) => {
  if (setup) await q.query(setup);
  await mirrorPaymentAllocations(co.B, [payment]);
});
const setConn = (set: string) => asAppUser(pool, U.ab, co.A, (q) => q.query(`UPDATE intercompany_connections SET ${set} WHERE id = $1`, [conn]), true);

describe('the hook on a cash connection', () => {
  it('writes the payment message (D3 answered not_loan first) and no allocation message', async () => {
    const { payment, allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    await hook(payment);
    expect(await paymentMessages(pool, allocation)).toHaveLength(1);
    expect(await count(pool, "SELECT count(*) AS n FROM intercompany_messages WHERE kind = 'allocation'")).toBe(0);
  });

  it('a loan connection gets the allocation message and no payment message', async () => {
    await setConn("settlement_mode = 'loan'");
    const { payment, allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    await hook(payment);
    expect(await paymentMessages(pool)).toHaveLength(0);
    expect(await count(pool, "SELECT count(*) AS n FROM intercompany_messages WHERE kind = 'allocation' AND source_doc_id = $1", [allocation])).toBe(1);
  });

  it('with the payer\'s flag off, nothing is sent (the hook asks no definer)', async () => {
    await setLoanClearing(pool, [co.B], false);
    const { payment } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    await hook(payment);
    expect(await count(pool, 'SELECT count(*) AS n FROM intercompany_messages WHERE from_company_id = $1', [co.B])).toBe(0);
  });

  it('a forced definer failure is logged by SQLSTATE and the payment\'s own writes commit', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { payment } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    await asService(pool, U.b, co.B, async (q) => {
      await q.query("SET LOCAL ic_f.fail = 'on'");
      await q.query("UPDATE supplier_payments SET reference = 'kept' WHERE id = $1", [payment]);
      await mirrorPaymentAllocations(co.B, [payment]);
    });
    expect((await pool.query('SELECT reference FROM supplier_payments WHERE id = $1', [payment])).rows[0].reference).toBe('kept');
    expect(await paymentMessages(pool)).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('payment message'), expect.objectContaining({ code: 'XX001' }), 'intercompany');
  });

  it('a forged 23505 inside the hook is info other_kind_sent, not an error', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const { payment } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    await hook(payment, "SET LOCAL ic_f.fail = 'dup'");
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: 'other_kind_sent' }), 'intercompany');
  });

  it('a held payer journal key makes D1 time out: log.error with 55P03, the payment stands', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { payment, journal } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const holder = await openSession(pool, U.b, co.B, null);
    try {
      await holder.query(journalKey(co.B, journal!));
      await hook(payment, "SET LOCAL lock_timeout = '300ms'");
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await paymentMessages(pool)).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ code: '55P03' }), 'intercompany');
  });
});

describe('Z1: one message per allocation row across a mode flip', () => {
  it('D1 then (mode flipped to loan) D3: D3 answers payment_sent', async () => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    expect((await sendPay(pool, allocation)).message_id).toBeTruthy();
    await setConn("settlement_mode = 'loan'");                                                   // (a pending bank-paid message holds nothing)
    expect(await sendAlloc(pool, allocation)).toEqual({ message_id: null, reason: 'payment_sent', detail: null });
    expect(await count(pool, 'SELECT count(*) AS n FROM intercompany_messages WHERE source_doc_id = $1', [allocation])).toBe(1);
  });

  it('D3 checks the payer flag in SQL: off, not_enabled', async () => {
    await setConn("settlement_mode = 'loan'");
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    await setLoanClearing(pool, [co.B], false);
    expect(await sendAlloc(pool, allocation)).toEqual({ message_id: null, reason: 'not_enabled', detail: null });
  });

  it('D3 takes the payer journal key before its link share: a held key makes it wait, then it re-reads (cash: not_loan); one message', async () => {
    const { allocation, journal } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    expect((await sendPay(pool, allocation)).message_id).toBeTruthy();
    const holder = await openSession(pool, U.b, co.B, null);
    await holder.query(journalKey(co.B, journal!));
    const waiting = sendAlloc(pool, allocation);
    try {
      await blockedOn(pool, 'intercompany_send_for_allocation', waiting);
      // while D3 waits on the key it holds no link or connection share: both rows can be locked for update without waiting
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query('SELECT 1 FROM intercompany_document_links WHERE connection_id = $1 FOR UPDATE NOWAIT', [conn]);
        await probe.query('SELECT 1 FROM intercompany_connections WHERE id = $1 FOR UPDATE NOWAIT', [conn]);
      } finally {
        await probe.query('ROLLBACK');
        probe.release();
      }
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await waiting).reason).toBe('not_loan');
    expect(await count(pool, 'SELECT count(*) AS n FROM intercompany_messages WHERE source_doc_id = $1', [allocation])).toBe(1);
  });

  it('D1 waits on the held key too, and a queued revoke behind its connection share ends with one consistent answer', async () => {
    const { allocation, journal } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const holder = await openSession(pool, U.b, co.B, null);
    await holder.query(journalKey(co.B, journal!));
    const waiting = sendPay(pool, allocation);
    try {
      await blockedOn(pool, 'intercompany_send_for_payment', waiting);
      // waiting on the key, D1 holds no link or connection share yet (MED-4: key first)
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query('SELECT 1 FROM intercompany_document_links WHERE connection_id = $1 FOR UPDATE NOWAIT', [conn]);
        await probe.query('SELECT 1 FROM intercompany_connections WHERE id = $1 FOR UPDATE NOWAIT', [conn]);
      } finally {
        await probe.query('ROLLBACK');
        probe.release();
      }
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect((await waiting).message_id).toBeTruthy();
    // D1 in an open transaction holds the link / connection shares: a revoke waits for it and then revokes
    const { allocation: second } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const s = await openSession(pool, U.b, co.B);
    try {
      expect((await s.query('SELECT * FROM public.intercompany_send_for_payment($1)', [second])).rows[0].message_id).toBeTruthy();
      const revoke = setConn("status = 'revoked'");
      await blockedOn(pool, 'UPDATE intercompany_connections', revoke);
      await s.query('COMMIT');
      await revoke;
    } finally {
      s.release();
    }
    expect(await paymentMessages(pool)).toHaveLength(2);
  });

  it('a revoke committed while D1 waits on the key: D1 re-reads after the wait and writes nothing', async () => {
    const { allocation, journal } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const holder = await openSession(pool, U.b, co.B, null);
    await holder.query(journalKey(co.B, journal!));
    const waiting = sendPay(pool, allocation);
    try {
      await blockedOn(pool, 'intercompany_send_for_payment', waiting);
      await setConn("status = 'revoked'");
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect((await waiting).reason).toBe('not_partner_supplier');
    expect(await paymentMessages(pool)).toHaveLength(0);
  });

  it('not_cash: a mode flip queued on the connection row while D1 waits for its share is re-read under the share', async () => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const flip = await openSession(pool, U.ab, co.A);
    await flip.query("UPDATE intercompany_connections SET settlement_mode = 'loan' WHERE id = $1", [conn]);
    const waiting = sendPay(pool, allocation);
    try {
      await blockedOn(pool, 'intercompany_send_for_payment', waiting);
      await flip.query('COMMIT');
    } finally {
      flip.release();
    }
    expect((await waiting).reason).toBe('not_cash');
    expect(await paymentMessages(pool)).toHaveLength(0);
  });
});
