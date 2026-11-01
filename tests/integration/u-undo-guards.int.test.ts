/**
 * Master plan U, adversarial review: what an Undo may not overwrite. A toast is offered for one state and runs in a
 * later one, so the server decides under its locks, and refuses a state the toast never offered:
 *
 *   - exclude keeps a line's match, and `unmatch` wipes it. A restore must not reach a line that carries one, however
 *     it got there: a stale grid (excluded while someone had matched it) or ABA (restored, matched, excluded again).
 *   - a journal with a second statement line on its chain is a transfer in all but name. Reversing it leaves the other
 *     line matched to cash the GL no longer holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { excludeTransaction, matchTransaction, unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { contraCount, journalLineOn, lineState, seedLineOn, secondBank, unclaimedLine } from './helpers/uUndoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const EXCLUDED_CHANGED = 'This line has changed since you excluded it.';
const ALLOCATED_CHANGED = 'This line has changed since you allocated it.';

let fx: Fixture;

describeIfDb('U: what an Undo may not overwrite', () => {
  beforeAll(async () => { fx = await seedFixture('UG', DATABASE_URL!); }, 60000);
  afterAll(async () => { await dropFixture(fx); }, 60000);

  describe('a restore, and a match the exclude kept', () => {
    const restore = (tx: string) => inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId, { expectedStatus: 'excluded' }));
    const exclude = (tx: string) => inTx(fx, () => excludeTransaction(fx.companyId, tx, 'dup', fx.userId));
    const match = (tx: string, line: string) => inTx(fx, () => matchTransaction(fx.companyId, tx, line, undefined, fx.userId));

    it('stale grid: the line someone matched reports it was matched, and a restore leaves the match', async () => {
      const line = await unclaimedLine(fx);
      const tx = await seedBankTx(fx, { date: '2026-04-01', amount: -71, description: 'STALE GRID' });
      await match(tx, line);

      expect((await exclude(tx)).priorStatus).toBe('matched');

      await expect(restore(tx)).rejects.toThrow(EXCLUDED_CHANGED);
      expect(await lineState(fx, tx)).toEqual({ status: 'excluded', matched: line });
    }, 60000);

    it('ABA: restored, matched and excluded again, the first toast finds `excluded` and still may not wipe the match', async () => {
      const line = await unclaimedLine(fx);
      const tx = await seedBankTx(fx, { date: '2026-04-02', amount: -72, description: 'ABA' });
      expect((await exclude(tx)).priorStatus).toBe('imported'); // the toast
      await inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId)); // someone else restores it...
      await match(tx, line); // ...matches it...
      await exclude(tx); // ...and excludes it again

      await expect(restore(tx)).rejects.toThrow(EXCLUDED_CHANGED);
      expect(await lineState(fx, tx)).toEqual({ status: 'excluded', matched: line });
    }, 60000);

    it('an imported line reports imported, and restores', async () => {
      const tx = await seedBankTx(fx, { date: '2026-04-03', amount: -73, description: 'PLAIN' });
      expect((await exclude(tx)).priorStatus).toBe('imported');
      await restore(tx);
      expect(await lineState(fx, tx)).toEqual({ status: 'imported', matched: null });
    }, 60000);
  });

  describe('a transfer in all but name: an `account` allocation to another bank', () => {
    async function allocatedToBank(day: string, amount: number) {
      const bank2 = await secondBank(fx);
      const tx = await seedBankTx(fx, { date: day, amount, description: 'BANK CONTRA' });
      const { journalEntryId: je } = await inTx(fx, () => allocateTransaction(fx.companyId, tx, bank2, fx.userId));
      const leg = await journalLineOn(fx, je, bank2);
      const other = await seedLineOn(fx, bank2, { date: day, amount: -amount, description: 'OTHER LEG' });
      return { tx, je, leg, other };
    }
    const undo = (tx: string, je: string) => inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId, { expectedJournalEntryId: je }));

    it('the second leg appearing after the toast: refused, nothing reversed, both lines stand', async () => {
      const { tx, je, leg, other } = await allocatedToBank('2026-04-06', -74);
      await inTx(fx, () => matchTransaction(fx.companyId, other, leg, undefined, fx.userId));

      await expect(undo(tx, je)).rejects.toThrow(ALLOCATED_CHANGED);

      expect(await contraCount(fx, je)).toBe(0);
      expect((await lineState(fx, tx)).status).toBe('allocated');
      expect(await lineState(fx, other)).toEqual({ status: 'matched', matched: leg });
    }, 60000);

    it('the second leg committing while the undo waits for the journal: refused all the same', async () => {
      const { tx, je, leg, other } = await allocatedToBank('2026-04-07', -75);
      // A match holds the journal FOR SHARE until it commits. The undo's first look finds no second line, so what it
      // has to catch is this one, once its own lock on the journal is granted.
      const peer = await fx.pool.connect();
      await peer.query('BEGIN');
      await peer.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR SHARE', [je]);
      await peer.query(`UPDATE bank_transactions SET status = 'matched', matched_journal_line_id = $1 WHERE id = $2`, [leg, other]);
      const undone = undo(tx, je).then(() => 'reversed', (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 1000));
      await peer.query('COMMIT');
      peer.release();

      expect(await undone).toBe(ALLOCATED_CHANGED);
      expect(await contraCount(fx, je)).toBe(0);
    }, 60000);

    it('with no second leg the undo goes through', async () => {
      const { tx, je } = await allocatedToBank('2026-04-08', -76);
      await undo(tx, je);
      expect(await contraCount(fx, je)).toBe(1);
      expect(await lineState(fx, tx)).toEqual({ status: 'imported', matched: null });
    }, 60000);

    it('the plain Reverse button is not an undo: it states nothing, and is not refused here', async () => {
      const { tx, je, leg, other } = await allocatedToBank('2026-04-09', -77);
      await inTx(fx, () => matchTransaction(fx.companyId, other, leg, undefined, fx.userId));
      await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));
      expect(await contraCount(fx, je)).toBe(1);
    }, 60000);
  });
});
