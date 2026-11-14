/**
 * POP inbox phase 2 on real PostgreSQL (migration 991 + popMatchSweep.sweepPopMatches as app_service):
 *   - a unique match (amount, date window, name) attaches the POP's document to its line;
 *   - lines outside the window, of another amount, a credit, or another company's never match;
 *   - two named lines, or two POPs wanting one line, are suggestions: nothing attached;
 *   - a line already carrying a POP document is skipped; a POP whose document is matched is not looked at;
 *   - not_found is retried, until payment_date + 14 days; a refused attach is final;
 *   - app_user: INSERT of a decision only for its own company's POP (composite FK), no DELETE.
 * Storage is stubbed (no object store in CI): the attach's mirror copy reads stub bytes.
 *
 * Fixture route: isaflow_test (assertNotProductionDb).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  asAppUser, asService, matchedLineOf, matchRow, seedLine, seedPop, setUpPopFixture, tearDownPopFixture, type PopFixture,
} from './helpers/popSweepFixture';

const h = vi.hoisted(() => ({
  refuse: new Set<string>(), attachCalls: [] as string[],
  /** Runs once, on another connection, just before the sweep locks `line`: a writer that got there first. */
  beforeLock: null as null | { line: string; run: () => Promise<unknown> },
}));
vi.mock('@/modules/accounting/services/bank/bankTxLock', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/bank/bankTxLock')>();
  return {
    ...real,
    lockBankTransactionForUpdate: vi.fn(async (companyId: string, bankTxId: string) => {
      const hook = h.beforeLock;
      if (hook?.line === bankTxId) { h.beforeLock = null; await hook.run(); }
      return real.lockBankTransactionForUpdate(companyId, bankTxId);
    }),
  };
});
vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documentStorage')>()),
  fetchRawBytes: vi.fn(async () => {
    const buffer = Buffer.from('%PDF-1.4 stub');
    return { buffer, hash: 'h', storedHash: 'h', size: buffer.length, fileType: 'application/pdf' };
  }),
}));
vi.mock('@/modules/accounting/services/capture/captureBankTxAttachService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/capture/captureBankTxAttachService')>();
  return {
    ...real,
    attachCapturedDocToBankTx: vi.fn(async (companyId: string, documentId: string, bankTxId: string, userId: string | null) => {
      h.attachCalls.push(documentId);
      if (h.refuse.has(documentId)) return { ok: false as const, reason: 'bank_tx_not_found' as const };
      return real.attachCapturedDocToBankTx(companyId, documentId, bankTxId, userId);
    }),
  };
});

import { companiesWithOpenPops, sweepPopMatches } from '@/modules/accounting/services/capture/pop/popMatchSweep';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url, max: 3 });
const [A, B] = [crypto.randomUUID(), crypto.randomUUID()];
const named = (name: string) => `DIGITAL PAYMENT DT ABSA BANK ${name.toUpperCase()}`;
let fx: PopFixture;
const sweep = (company = A) => asService(pool, () => sweepPopMatches(company));

describeIfDb('POP matching: attach each POP to its bank line', () => {
  beforeAll(async () => {
    assertNotProductionDb('pop-match-sweep inserts companies, bank lines and proofs of payment');
    fx = await setUpPopFixture(pool, [A, B]);
  });

  afterAll(async () => {
    try { await tearDownPopFixture(fx); } finally { await pool.end(); }
  });

  it('attaches on a unique match and ignores every line that fails one test', async () => {
    const D = fx.day(5);
    const pop = await seedPop(fx, A, { beneficiary: 'Tintswalo G Mabehla', date: D });
    const right = await seedLine(fx, A, fx.day(3), '-3000.00', 'Imdte Digital Pmt — Absa Bank Tintswalo G Mabehla 161af7fea1');
    await seedLine(fx, A, D, '-3000.00', named('SOMEONE ELSE')); // same day and amount, another name
    await seedLine(fx, A, fx.day(1), '-3000.00', named('Tintswalo G Mabehla')); // D + 4: outside the window
    await seedLine(fx, A, fx.day(6), '-3000.00', named('Tintswalo G Mabehla')); // D - 1: before the payment
    await seedLine(fx, A, D, '-2999.99', named('Tintswalo G Mabehla')); // another amount
    await seedLine(fx, A, D, '3000.00', named('Tintswalo G Mabehla')); // a credit
    await seedLine(fx, B, D, '-3000.00', named('Tintswalo G Mabehla')); // another company's line
    await seedPop(fx, B, { beneficiary: 'Tintswalo G Mabehla', date: D }); // and another company's POP

    expect(await sweep()).toMatchObject({ attached: 1, ambiguous: 0, errors: 0 });
    expect(await matchedLineOf(pool, pop.documentId)).toBe(right);
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'attached', candidate_bank_tx_ids: [right], refusal: null });
    const copies = await pool.query('SELECT file_name FROM bank_transaction_attachments WHERE bank_transaction_id = $1', [right]);
    expect(copies.rows).toEqual([{ file_name: `${pop.documentId}_ABSA POP ${(await pool.query(
      'SELECT transaction_number FROM proof_of_payments WHERE id = $1', [pop.popId])).rows[0].transaction_number}.pdf` }]);
  });

  it('finds nothing when the only named lines are outside the window or of another amount', async () => {
    const D = fx.day(8);
    const pop = await seedPop(fx, A, { beneficiary: 'Window Test Pty', date: D, amount: '1250.00' });
    await seedLine(fx, A, fx.day(4), '-1250.00', named('Window Test Pty')); // D + 4
    await seedLine(fx, A, fx.day(9), '-1250.00', named('Window Test Pty')); // D - 1
    await seedLine(fx, A, D, '-1250.01', named('Window Test Pty'));
    await sweep();
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'not_found', candidate_bank_tx_ids: [], refusal: null });
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
  });

  it('suggests both lines and attaches nothing when two lines carry the name', async () => {
    const D = fx.day(6);
    const pop = await seedPop(fx, A, { beneficiary: 'Amoepong Bed and Bre', date: D, amount: '480.00' });
    const l1 = await seedLine(fx, A, D, '-480.00', named('Amoepong Bed and Breakfast'));
    const l2 = await seedLine(fx, A, fx.day(3), '-480.00', named('Amoepong Bed and Breakfast'));
    expect(await sweep()).toMatchObject({ attached: 0, errors: 0 });
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'ambiguous', candidate_bank_tx_ids: [l1, l2].sort(), refusal: null });
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
    // A suggestion is final for the matcher: one candidate going elsewhere does not make the other an auto-attach.
    await seedPop(fx, A, { beneficiary: 'Someone Else Entirely', date: D, amount: '480.00', matchedTo: l1 });
    await sweep();
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
    expect((await matchRow(pool, pop.popId))?.outcome).toBe('ambiguous');
  });

  it('makes two POPs wanting one line both suggestions', async () => {
    const D = fx.day(4);
    const p1 = await seedPop(fx, A, { beneficiary: 'Twin Payee', date: D, amount: '3000.00' });
    const p2 = await seedPop(fx, A, { beneficiary: 'Twin Payee', date: D, amount: '3000.00' });
    const l = await seedLine(fx, A, D, '-3000.00', named('Twin Payee'));
    await sweep();
    for (const p of [p1, p2]) {
      expect(await matchRow(pool, p.popId)).toEqual({ outcome: 'ambiguous', candidate_bank_tx_ids: [l], refusal: null });
      expect(await matchedLineOf(pool, p.documentId)).toBeNull();
    }
  });

  it('skips a line that already carries a POP, and a POP whose document is already matched', async () => {
    const D = fx.day(3);
    const taken = await seedLine(fx, A, D, '-700.00', named('Taken Line Co'));
    const earlier = await seedPop(fx, A, { beneficiary: 'Taken Line Co', date: D, amount: '700.00', matchedTo: taken });
    const pop = await seedPop(fx, A, { beneficiary: 'Taken Line Co', date: D, amount: '700.00' });
    await sweep();
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'not_found', candidate_bank_tx_ids: [], refusal: null });
    expect(await matchRow(pool, earlier.popId)).toBeNull();
    expect(await matchedLineOf(pool, earlier.documentId)).toBe(taken);
  });

  it('retries not_found on a later tick, and attaches once the line arrives', async () => {
    const D = fx.day(2);
    const pop = await seedPop(fx, A, { beneficiary: 'Late Statement Ltd', date: D, amount: '99.50' });
    await sweep();
    expect(await asService(pool, () => companiesWithOpenPops())).toContain(A);
    expect((await matchRow(pool, pop.popId))?.outcome).toBe('not_found');
    const l = await seedLine(fx, A, fx.day(1), '-99.50', named('Late Statement Ltd'));
    await sweep();
    expect(await matchRow(pool, pop.popId)).toMatchObject({ outcome: 'attached', candidate_bank_tx_ids: [l] });
    expect(await matchedLineOf(pool, pop.documentId)).toBe(l);
  });

  it('stops looking 14 days after the payment date', async () => {
    const old = await seedPop(fx, A, { beneficiary: 'Old Payment Cc', date: fx.day(15), amount: '55.00' });
    await seedLine(fx, A, fx.day(15), '-55.00', named('Old Payment Cc'));
    const edge = await seedPop(fx, A, { beneficiary: 'Edge Payment Cc', date: fx.day(14), amount: '56.00' });
    const edgeLine = await seedLine(fx, A, fx.day(14), '-56.00', named('Edge Payment Cc'));
    await sweep();
    expect(await matchRow(pool, old.popId)).toBeNull();
    expect(await matchedLineOf(pool, old.documentId)).toBeNull();
    expect(await matchedLineOf(pool, edge.documentId)).toBe(edgeLine);
  });

  it('skips a company another sweep holds', async () => {
    const pop = await seedPop(fx, A, { beneficiary: 'Held Company Co', date: fx.day(1), amount: '77.00' });
    await seedLine(fx, A, fx.day(1), '-77.00', named('Held Company Co'));
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [`pop_match_sweep:${A}`]);
      expect(await sweep()).toMatchObject({ checked: 0 });
      expect(await matchRow(pool, pop.popId)).toBeNull();
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [`pop_match_sweep:${A}`]);
      holder.release();
    }
    expect(await sweep()).toMatchObject({ attached: 1 });
  });

  it('leaves a POP alone when its line was taken, or its document matched, before the lock', async () => {
    const D = fx.day(2);
    const pop = await seedPop(fx, A, { beneficiary: 'Race Line Co', date: D, amount: '31.00' });
    const l = await seedLine(fx, A, D, '-31.00', named('Race Line Co'));
    const other = await seedPop(fx, A, { beneficiary: 'Race Other Co', date: fx.day(30), amount: '31.00' });
    h.beforeLock = { line: l, run: () => pool.query('UPDATE captured_documents SET matched_bank_tx_id = $1 WHERE id = $2', [l, other.documentId]) };
    await sweep();
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
    expect(await matchRow(pool, pop.popId)).toBeNull();

    const pop2 = await seedPop(fx, A, { beneficiary: 'Race Doc Co', date: D, amount: '32.00' });
    const l2 = await seedLine(fx, A, D, '-32.00', named('Race Doc Co'));
    const elsewhere = await seedLine(fx, A, D, '-1.00', 'SOMETHING ELSE');
    h.beforeLock = { line: l2, run: () => pool.query('UPDATE captured_documents SET matched_bank_tx_id = $1 WHERE id = $2', [elsewhere, pop2.documentId]) };
    await sweep();
    expect(await matchedLineOf(pool, pop2.documentId)).toBe(elsewhere);
    expect(await matchRow(pool, pop2.popId)).toBeNull();
    expect(h.beforeLock).toBeNull();
  });

  it('records a refused attach once and does not try it again', async () => {
    const D = fx.day(2);
    const pop = await seedPop(fx, A, { beneficiary: 'Refused Attach Co', date: D, amount: '12.00' });
    const l = await seedLine(fx, A, D, '-12.00', named('Refused Attach Co'));
    h.refuse.add(pop.documentId);
    expect(await sweep()).toMatchObject({ refused: 1 });
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'refused', candidate_bank_tx_ids: [l], refusal: 'bank_tx_not_found' });
    h.attachCalls.length = 0;
    await sweep();
    expect(h.attachCalls).not.toContain(pop.documentId);
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
  });

  it('app_user writes a decision for its own company\'s POP only, and cannot delete one', async () => {
    const popA = await seedPop(fx, A, { beneficiary: 'Grant Check', date: fx.day(1), amount: '1.00' });
    const insert = "INSERT INTO proof_of_payment_matches (company_id, proof_of_payment_id, outcome) VALUES ($1, $2, 'not_found')";
    expect(await asAppUser(fx, A, insert, [A, popA.popId])).toBe('ok:1');
    // Company B's session naming A's POP under its own company id: the composite foreign key refuses it.
    expect(await asAppUser(fx, B, insert, [B, popA.popId])).toBe('23503');
    expect(await asAppUser(fx, A, 'SELECT 1 FROM proof_of_payment_matches WHERE company_id = $1', [A])).not.toBe('ok:0');
    expect(await asAppUser(fx, B, 'SELECT 1 FROM proof_of_payment_matches WHERE company_id = $1', [A])).toBe('ok:0');
    expect(await asAppUser(fx, A, 'DELETE FROM proof_of_payment_matches WHERE company_id = $1', [A])).toBe('42501');
    expect(await asAppUser(fx, A, "UPDATE proof_of_payment_matches SET company_id = $1 WHERE company_id = $1", [A])).toBe('42501');
  });
});
