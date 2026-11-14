/**
 * POP inbox phase 2 on real PostgreSQL (migration 991 + popMatchSweep.sweepPopMatches as app_service), the
 * decisions: a unique match attaches; every line failing one test is ignored (window, amount, credit, another
 * company, not posted, no description); two lines or two POPs → suggestions, final; a rival POP outside the batch
 * blocks; an account not imported past the window waits; payment_date + 45 days (SAST) ends the search.
 * Races, finality in the database, grants and RLS: pop-match-sweep-guards.int.test.ts.
 * Storage is stubbed (no object store in CI): the attach's mirror copy reads stub bytes.
 *
 * Fixture route: isaflow_test (assertNotProductionDb).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  addBankAccount, asService, cover, matchedLineOf, matchRow, seedLine, seedPop, setUpPopFixture, tearDownPopFixture, type PopFixture,
} from './helpers/popSweepFixture';

vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documentStorage')>()),
  fetchRawBytes: vi.fn(async () => {
    const buffer = Buffer.from('%PDF-1.4 stub');
    return { buffer, hash: 'h', storedHash: 'h', size: buffer.length, fileType: 'application/pdf' };
  }),
}));

import { companiesWithOpenPops, sweepPopMatches } from '@/modules/accounting/services/capture/pop/popMatchSweep';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url, max: 3 });
const [A, B, C] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const named = (name: string) => `DIGITAL PAYMENT DT ABSA BANK ${name.toUpperCase()}`;
let fx: PopFixture;
const sweep = (company = A, limit?: number, setup: string[] = []) => asService(pool, () => sweepPopMatches(company, limit), setup);
const finalRow = (company: string, popId: string, outcome: string, lines: string[]) => pool.query(
  'INSERT INTO proof_of_payment_matches (company_id, proof_of_payment_id, outcome, candidate_bank_tx_ids) VALUES ($1, $2, $3, $4)',
  [company, popId, outcome, lines]);

describeIfDb('POP matching: attach each POP to its bank line', () => {
  beforeAll(async () => {
    assertNotProductionDb('pop-match-sweep inserts companies, bank lines and proofs of payment');
    fx = await setUpPopFixture(pool, [A, B, C]);
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
    await seedLine(fx, A, D, '-3000.00', 'DIGITAL PAYMENT DT TINTSWALO G MABEHLA'); // no "ABSA BANK"
    await seedLine(fx, A, D, '-3000.00', named('Tintswalo G Mabehla'), { feedState: 'pending' }); // not posted
    await seedLine(fx, B, D, '-3000.00', named('Tintswalo G Mabehla')); // another company's line
    await seedPop(fx, B, { beneficiary: 'Tintswalo G Mabehla', date: D }); // and another company's POP

    expect(await sweep()).toMatchObject({ attached: 1, ambiguous: 0, errors: 0 });
    expect(await matchedLineOf(pool, pop.documentId)).toBe(right);
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'attached', candidate_bank_tx_ids: [right], refusal: null });
    const copies = await pool.query('SELECT file_name FROM bank_transaction_attachments WHERE bank_transaction_id = $1', [right]);
    expect(copies.rows).toHaveLength(1);
    expect((await pool.query('SELECT status FROM captured_documents WHERE id = $1', [pop.documentId])).rows[0].status).toBe('matched');
  });

  it('finds nothing in a window or amount that differs, a line not posted, or a line without a description', async () => {
    const D = fx.day(8);
    const pop = await seedPop(fx, A, { beneficiary: 'Window Test Pty', date: D, amount: '1250.00' });
    await seedLine(fx, A, fx.day(4), '-1250.00', named('Window Test Pty')); // D + 4
    await seedLine(fx, A, fx.day(9), '-1250.00', named('Window Test Pty')); // D - 1
    await seedLine(fx, A, D, '-1250.01', named('Window Test Pty'));
    await seedLine(fx, A, D, '-1250.00', named('Window Test Pty'), { feedState: 'pending' });
    await seedLine(fx, A, D, '-1250.00', named('Window Test Pty'), { feedState: 'removed' });
    await seedLine(fx, A, D, '-1250.00', null);
    await sweep();
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'not_found', candidate_bank_tx_ids: [], refusal: null });
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
  });

  it('suggests both lines when two carry the name, and the suggestion stays final', async () => {
    const D = fx.day(6);
    const pop = await seedPop(fx, A, { beneficiary: 'Amoepong Bed and Bre', date: D, amount: '480.00' });
    const l1 = await seedLine(fx, A, D, '-480.00', named('Amoepong Bed and Breakfast'));
    const l2 = await seedLine(fx, A, fx.day(3), '-480.00', named('Amoepong Bed and Breakfast'));
    expect(await sweep()).toMatchObject({ attached: 0, errors: 0 });
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'ambiguous', candidate_bank_tx_ids: [l1, l2].sort(), refusal: null });
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
    // One candidate goes elsewhere: l2 is now this POP's only free line, but the suggestion is final.
    await seedPop(fx, A, { beneficiary: 'Someone Else Entirely', date: D, amount: '480.00', matchedTo: l1 });
    await sweep();
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
    expect((await matchRow(pool, pop.popId))?.outcome).toBe('ambiguous');
    // Control: without its final row the same POP does attach to l2, so finality (not the data) held it.
    await pool.query('DELETE FROM proof_of_payment_matches WHERE proof_of_payment_id = $1', [pop.popId]);
    await sweep();
    expect(await matchedLineOf(pool, pop.documentId)).toBe(l2);
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

  it('lets a rival outside the batch block the attach: an earlier, final ambiguous POP still claims its line', async () => {
    const D = fx.day(4);
    const l = await seedLine(fx, A, D, '-610.00', named('Rival Claim Co'));
    const earlier = await seedPop(fx, A, { beneficiary: 'Rival Claim Co', date: D, amount: '610.00' });
    await finalRow(A, earlier.popId, 'ambiguous', [l]);
    const pop = await seedPop(fx, A, { beneficiary: 'Rival Claim Co', date: D, amount: '610.00' });
    await sweep();
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'ambiguous', candidate_bank_tx_ids: [l], refusal: null });
    expect(await matchedLineOf(pool, pop.documentId)).toBeNull();
  });

  it('honours the batch limit, and a rival left out of the batch still blocks', async () => {
    const D = fx.day(20); // older than B's other open POP, so these two head the batch
    const l = await seedLine(fx, B, D, '-620.00', named('Limit Rival Co'));
    const p1 = await seedPop(fx, B, { beneficiary: 'Limit Rival Co', date: D, amount: '620.00' });
    const p2 = await seedPop(fx, B, { beneficiary: 'Limit Rival Co', date: D, amount: '620.00' });
    expect(await sweep(B, 1)).toMatchObject({ checked: 1, attached: 0, ambiguous: 1 });
    const rows = [await matchRow(pool, p1.popId), await matchRow(pool, p2.popId)];
    expect(rows.filter((r) => r === null)).toHaveLength(1);
    expect(rows.find((r) => r !== null)).toEqual({ outcome: 'ambiguous', candidate_bank_tx_ids: [l], refusal: null });
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

  it('waits while the line\'s account is not imported past the window, then attaches; ambiguity spans accounts', async () => {
    const D = fx.day(10);
    const fresh = await addBankAccount(pool, A);
    const pop = await seedPop(fx, A, { beneficiary: 'Coverage Gate Co', date: D, amount: '830.00' });
    const l = await seedLine(fx, A, D, '-830.00', named('Coverage Gate Co'), { account: fresh });
    await seedLine(fx, A, fx.day(7), '-1.00', 'BANK CHARGE', { account: fresh }); // D + 3: inside, not past, the window
    await sweep();
    expect(await matchRow(pool, pop.popId)).toEqual({ outcome: 'not_found', candidate_bank_tx_ids: [], refusal: null });
    await seedLine(fx, A, fx.day(6), '-1.00', 'BANK CHARGE', { account: fresh }); // D + 4
    await sweep();
    expect(await matchedLineOf(pool, pop.documentId)).toBe(l);

    const other = await addBankAccount(pool, A);
    const pop2 = await seedPop(fx, A, { beneficiary: 'Two Accounts Co', date: D, amount: '840.00' });
    const covered = await seedLine(fx, A, D, '-840.00', named('Two Accounts Co'));
    const uncovered = await seedLine(fx, A, D, '-840.00', named('Two Accounts Co'), { account: other });
    await sweep();
    expect(await matchRow(pool, pop2.popId)).toEqual({ outcome: 'ambiguous', candidate_bank_tx_ids: [covered, uncovered].sort(), refusal: null });
  });

  it('retries not_found on a later tick, and attaches once the line arrives', async () => {
    const D = fx.day(2);
    const pop = await seedPop(fx, A, { beneficiary: 'Late Statement Ltd', date: D, amount: '99.50' });
    await sweep();
    expect((await matchRow(pool, pop.popId))?.outcome).toBe('not_found');
    expect(await asService(pool, () => companiesWithOpenPops())).toContain(A);
    const l = await seedLine(fx, A, fx.day(1), '-99.50', named('Late Statement Ltd'));
    await sweep();
    expect(await matchRow(pool, pop.popId)).toMatchObject({ outcome: 'attached', candidate_bank_tx_ids: [l] });
  });

  // Run under a clock behind SAST and one ahead: at any hour one of them puts current_date on another day than SAST's.
  for (const zone of ['Etc/GMT+12', 'Pacific/Kiritimati']) {
    it(`stops looking 45 days after the payment date, by SAST's date (session zone ${zone})`, async () => {
      const tag = zone.replace(/\W/g, '');
      const old = await seedPop(fx, A, { beneficiary: `Old Payment ${tag}`, date: fx.day(46), amount: '55.00' });
      await seedLine(fx, A, fx.day(46), '-55.00', named(`Old Payment ${tag}`));
      const edge = await seedPop(fx, A, { beneficiary: `Edge Payment ${tag}`, date: fx.day(45), amount: '56.00' });
      const edgeLine = await seedLine(fx, A, fx.day(45), '-56.00', named(`Edge Payment ${tag}`));
      await sweep(A, undefined, [`SET LOCAL TIME ZONE '${zone}'`]);
      expect(await matchRow(pool, old.popId)).toBeNull();
      expect(await matchedLineOf(pool, old.documentId)).toBeNull();
      expect(await matchedLineOf(pool, edge.documentId)).toBe(edgeLine);
    });
  }

  it('does not list a company whose POPs are all final, matched or past the cutoff', async () => {
    const amb = await seedPop(fx, C, { beneficiary: 'Final Only Co', date: fx.day(2), amount: '1.00' });
    await finalRow(C, amb.popId, 'ambiguous', [await cover(fx, C)]);
    await seedPop(fx, C, { beneficiary: 'Expired Co', date: fx.day(46), amount: '2.00' });
    await seedPop(fx, C, { beneficiary: 'Matched Co', date: fx.day(2), amount: '3.00', matchedTo: await cover(fx, C) });
    for (const zone of ['Etc/GMT+12', 'Pacific/Kiritimati']) {
      expect(await asService(pool, () => companiesWithOpenPops(), [`SET LOCAL TIME ZONE '${zone}'`])).not.toContain(C);
    }
    await seedPop(fx, C, { beneficiary: 'Open Co', date: fx.day(45), amount: '4.00' });
    expect(await asService(pool, () => companiesWithOpenPops())).toContain(C);
  });
});
