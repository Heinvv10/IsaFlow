/**
 * POP matching guards on real PostgreSQL (popMatchSweep + migrations 991/992): one sweep per company; a line or
 * document that moved before the lock is left (`moved`); a final decision written before the lock rolls the attach
 * back; a refused attach is final; a thrown attach is counted and retried; finality enforced by 991's trigger for
 * every role; app_user's grants and RLS; FORCE ROW LEVEL SECURITY on every new table.
 *
 * Fixture route: isaflow_test (assertNotProductionDb).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  addBankAccount, asAppUser, asService, cover, matchedLineOf, matchRow, seedLine, seedPop, setUpPopFixture, tearDownPopFixture,
  type PopFixture,
} from './helpers/popSweepFixture';

const h = vi.hoisted(() => ({
  refuse: new Set<string>(), explode: new Set<string>(), attachCalls: [] as string[],
  /** Runs once, on another connection, just before the sweep locks `line`: a writer that got there first. */
  beforeLock: null as null | { line: string; run: () => Promise<unknown> },
}));
vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documentStorage')>()),
  fetchRawBytes: vi.fn(async () => {
    const buffer = Buffer.from('%PDF-1.4 stub');
    return { buffer, hash: 'h', storedHash: 'h', size: buffer.length, fileType: 'application/pdf' };
  }),
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
vi.mock('@/modules/accounting/services/capture/captureBankTxAttachService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/capture/captureBankTxAttachService')>();
  return {
    ...real,
    attachCapturedDocToBankTx: vi.fn(async (companyId: string, documentId: string, bankTxId: string, userId: string | null) => {
      h.attachCalls.push(documentId);
      if (h.explode.has(documentId)) throw new Error('attach exploded');
      if (h.refuse.has(documentId)) return { ok: false as const, reason: 'bank_tx_not_found' as const };
      return real.attachCapturedDocToBankTx(companyId, documentId, bankTxId, userId);
    }),
  };
});

import { sweepPopMatches } from '@/modules/accounting/services/capture/pop/popMatchSweep';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url, max: 3 });
const [A, B] = [crypto.randomUUID(), crypto.randomUUID()];
const named = (name: string) => `DIGITAL PAYMENT DT ABSA BANK ${name.toUpperCase()}`;
let fx: PopFixture;
const sweep = () => asService(pool, () => sweepPopMatches(A));

describeIfDb('POP matching guards', () => {
  beforeAll(async () => {
    assertNotProductionDb('pop-match-sweep-guards inserts companies, bank lines and proofs of payment');
    fx = await setUpPopFixture(pool, [A, B]);
  });

  afterAll(async () => {
    try { await tearDownPopFixture(fx); } finally { await pool.end(); }
  });

  it('skips a company another sweep holds', async () => {
    const pop = await seedPop(fx, A, { beneficiary: 'Held Company Co', date: fx.day(5), amount: '77.00' });
    await seedLine(fx, A, fx.day(5), '-77.00', named('Held Company Co'));
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

  it('leaves a POP alone (moved) when its line was taken, or its document matched, before the lock', async () => {
    const D = fx.day(5);
    const pop = await seedPop(fx, A, { beneficiary: 'Race Line Co', date: D, amount: '31.00' });
    const l = await seedLine(fx, A, D, '-31.00', named('Race Line Co'));
    const other = await seedPop(fx, A, { beneficiary: 'Race Other Co', date: fx.day(60), amount: '31.00' });
    h.beforeLock = { line: l, run: () => pool.query('UPDATE captured_documents SET matched_bank_tx_id = $1 WHERE id = $2', [l, other.documentId]) };
    expect(await sweep()).toMatchObject({ moved: 1, attached: 0 });
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
    expect(await matchRow(pool, pop.popId)).toBeNull();

    const pop2 = await seedPop(fx, A, { beneficiary: 'Race Doc Co', date: D, amount: '32.00' });
    const l2 = await seedLine(fx, A, D, '-32.00', named('Race Doc Co'));
    const elsewhere = await seedLine(fx, A, D, '-1.00', 'SOMETHING ELSE');
    h.beforeLock = { line: l2, run: () => pool.query('UPDATE captured_documents SET matched_bank_tx_id = $1 WHERE id = $2', [elsewhere, pop2.documentId]) };
    expect(await sweep()).toMatchObject({ moved: 1 });
    expect(await matchedLineOf(pool, pop2.documentId)).toBe(elsewhere);
    expect(await matchRow(pool, pop2.popId)).toBeNull();
    expect(h.beforeLock).toBeNull();
  });

  // A posted line cannot stop being posted (BANK_TX_FEED_GUARD refuses posted → pending/removed), so the re-check's
  // feed_state test has no case here.
  it('leaves a POP alone (moved) when, before the lock, the line changed or a new rival POP was filed', async () => {
    const D = fx.day(5);
    const cases: Array<[string, (line: string, amount: string, name: string) => Promise<unknown>]> = [
      ['new rival POP', (_l, amount) => seedPop(fx, A, { beneficiary: 'Recheck New Rival', date: D, amount })],
      ['amount changed', (l) => pool.query("UPDATE bank_transactions SET amount = amount - 0.01 WHERE id = $1", [l])],
      ['date moved out of the window', (l) => pool.query('UPDATE bank_transactions SET transaction_date = $2 WHERE id = $1', [l, fx.day(10)])],
      ['description renamed', (l) => pool.query("UPDATE bank_transactions SET description = 'DIGITAL PAYMENT DT ABSA BANK SOMEONE ELSE' WHERE id = $1", [l])],
      ['a second line for the same POP imported', (_l, amount, name) => seedLine(fx, A, D, `-${amount}`, named(name))],
    ];
    for (const [i, [label, change]] of cases.entries()) {
      const amount = `${41 + i}.00`;
      const name = label === 'new rival POP' ? 'Recheck New Rival' : `Recheck Case ${i}`;
      const pop = await seedPop(fx, A, { beneficiary: name, date: D, amount });
      const l = await seedLine(fx, A, D, `-${amount}`, named(name));
      h.beforeLock = { line: l, run: () => change(l, amount, name) };
      expect([label, await sweep()]).toMatchObject([label, { moved: 1, attached: 0 }]);
      expect([label, await matchedLineOf(pool, pop.documentId)]).toEqual([label, null]);
      expect([label, await matchRow(pool, pop.popId)]).toEqual([label, null]);
    }
  });

    it('leaves a POP alone (moved) when its account stopped reading as imported past the window before the lock', async () => {
    const D = fx.day(5);
    const account = await addBankAccount(pool, A);
    const later = await cover(fx, A, account);
    const pop = await seedPop(fx, A, { beneficiary: 'Recheck Coverage Co', date: D, amount: '48.00' });
    const l = await seedLine(fx, A, D, '-48.00', named('Recheck Coverage Co'), { account });
    // The dated line goes; a misdated future line arrives instead, which opens nothing.
    h.beforeLock = { line: l, run: async () => {
      await pool.query('DELETE FROM bank_transactions WHERE id = $1', [later]);
      await seedLine(fx, A, fx.day(-3), '-1.00', 'BANK CHARGE', { account });
    } };
    expect(await sweep()).toMatchObject({ moved: 1, attached: 0 });
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
    expect(await matchRow(pool, pop.popId)).toBeNull();
  });

  it('rolls the attach back when a final decision appeared before it could be recorded', async () => {
    const D = fx.day(5);
    const pop = await seedPop(fx, A, { beneficiary: 'Late Final Co', date: D, amount: '33.00' });
    const l = await seedLine(fx, A, D, '-33.00', named('Late Final Co'));
    h.beforeLock = { line: l, run: () => pool.query(`INSERT INTO proof_of_payment_matches (company_id, proof_of_payment_id, outcome,
      candidate_bank_tx_ids) VALUES ($1, $2, 'ambiguous', $3)`, [A, pop.popId, [l]]) };
    expect(await sweep()).toMatchObject({ attached: 0, errors: 1 });
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
    expect((await pool.query('SELECT 1 FROM bank_transaction_attachments WHERE bank_transaction_id = $1', [l])).rowCount).toBe(0);
    expect((await matchRow(pool, pop.popId))?.outcome).toBe('ambiguous');
  });

  it('counts an attach that throws, records nothing, and tries again next tick', async () => {
    const D = fx.day(5);
    const pop = await seedPop(fx, A, { beneficiary: 'Throwing Attach Co', date: D, amount: '34.00' });
    const l = await seedLine(fx, A, D, '-34.00', named('Throwing Attach Co'));
    h.explode.add(pop.documentId);
    expect(await sweep()).toMatchObject({ errors: 1, attached: 0 });
    expect(await matchRow(pool, pop.popId)).toBeNull();
    h.explode.delete(pop.documentId);
    expect(await sweep()).toMatchObject({ attached: 1 });
    expect(await matchedLineOf(pool, pop.documentId)).toBe(l);
  });

  it('records a refused attach once and does not try it again', async () => {
    const D = fx.day(5);
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

  it('refuses any UPDATE of a final decision, for app_user and app_service; a not_found row may change', async () => {
    const fin = await seedPop(fx, A, { beneficiary: 'Final Row Co', date: fx.day(1), amount: '2.00' });
    const open = await seedPop(fx, A, { beneficiary: 'Open Row Co', date: fx.day(1), amount: '3.00' });
    const line = await seedLine(fx, A, fx.day(1), '-2.00', 'X');
    await pool.query(`INSERT INTO proof_of_payment_matches (company_id, proof_of_payment_id, outcome, candidate_bank_tx_ids)
      VALUES ($1, $2, 'ambiguous', $3), ($1, $4, 'not_found', '{}')`, [A, fin.popId, [line], open.popId]);
    const reopen = "UPDATE proof_of_payment_matches SET outcome = 'not_found', candidate_bank_tx_ids = '{}' WHERE proof_of_payment_id = $1";
    for (const role of ['app_user', 'app_service'] as const) {
      expect(await asAppUser(fx, A, reopen, [fin.popId], role)).toBe('23001');
      expect(await asAppUser(fx, A, 'UPDATE proof_of_payment_matches SET checked_at = now() WHERE proof_of_payment_id = $1', [open.popId], role)).toBe('ok:1');
    }
    await expect(pool.query(reopen, [fin.popId])).rejects.toMatchObject({ code: '23001' }); // the owner too
  });

  it('app_user writes a decision for its own company\'s POP only, sees only its own, and cannot delete one', async () => {
    const popA = await seedPop(fx, A, { beneficiary: 'Grant Check', date: fx.day(1), amount: '1.00' });
    const insert = "INSERT INTO proof_of_payment_matches (company_id, proof_of_payment_id, outcome) VALUES ($1, $2, 'not_found')";
    expect(await asAppUser(fx, A, insert, [A, popA.popId])).toBe('ok:1');
    // Company B's session naming A's POP under its own company id: the composite foreign key refuses it.
    expect(await asAppUser(fx, B, insert, [B, popA.popId])).toBe('23503');
    expect(await asAppUser(fx, A, 'SELECT 1 FROM proof_of_payment_matches WHERE company_id = $1', [A])).not.toBe('ok:0');
    expect(await asAppUser(fx, B, 'SELECT 1 FROM proof_of_payment_matches WHERE company_id = $1', [A])).toBe('ok:0');
    expect(await asAppUser(fx, A, 'DELETE FROM proof_of_payment_matches WHERE company_id = $1', [A])).toBe('42501');
    expect(await asAppUser(fx, A, 'UPDATE proof_of_payment_matches SET company_id = $1 WHERE company_id = $1', [A])).toBe('42501');
  });

  it('forces row level security on every table 991 and 992 create', async () => {
    const { rows } = await pool.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`,
    [['pop_archive_attempts', 'pop_archive_copies', 'pop_archive_targets', 'proof_of_payment_matches']]);
    expect(rows).toEqual(['pop_archive_attempts', 'pop_archive_copies', 'pop_archive_targets', 'proof_of_payment_matches']
      .map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
  });
});
