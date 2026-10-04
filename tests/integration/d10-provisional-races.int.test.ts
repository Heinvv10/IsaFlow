/**
 * D10 round 2 — "is the provisional X out?" decided under X's chain-head lock, never on an unlocked read.
 *
 * F1 (brk-d10 prov3): an evidenced X the GL reversed once (k = 1, out), its line still 'matched' and linked, the slip's
 *    bill in draft. A = the bank reversal of the line (real route), paused right before its reset; meanwhile B = the GL
 *    re-reversal of R1 (X back in force) and C = the bill's approval (its claim settles X while the line still reads
 *    'matched'); then A frees the line and clears the link. On e23800f41 all three committed: X settled AND its line
 *    free to be allocated again (bank credited twice for one statement line). Every serial order refuses one of them.
 * O-b: the auto-post undo's "provisional reversed by hand" branch clears the line's link on the same unlocked verdict;
 *    a re-reversal landing before its reset left X standing with no line.
 * Fixed: both take X's chain head (after the line: the D8 order) and decide under it; a re-reversal waits for them.
 */
import { describe, expect, it } from 'vitest';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { findJournalChainHead } from '@/modules/accounting/services/shared/journalChainHead';
import {
  callRoute, company, inTx, pool, seedDoc, seedInvoice, seedProvisional, useR127Fixture, user,
} from './r127-double-booking.helpers';
import { armBefore } from './d10-hook';

useR127Fixture();
type R = (req: never, res: never) => unknown;
const line = async (bt: string) => (await pool.query(
  'SELECT status, provisional_je_id::TEXT AS prov FROM bank_transactions WHERE id = $1', [bt])).rows[0];
const settlements = async (x: string) => (await pool.query(
  "SELECT id FROM supplier_payments WHERE company_id = $1 AND settles_provisional_je_id = $2 AND status <> 'cancelled'",
  [company, x])).rows.length;
const standing = async (x: string) => {
  const h = await findJournalChainHead(company, x);
  return h?.kind === 'head' && h.standing;
};
const reverseRoute = (bt: string) =>
  callRoute(bankTransactionsAction as R, '/api/accounting/bank-transactions-action', { action: 'reverse', bankTransactionId: bt });
const reReverse = (r1: string) => callRoute(journalEntriesAction as R, '/api/accounting/journal-entries-action', { id: r1, action: 'reverse' });
const approve = (bill: string) =>
  callRoute(supplierInvoicesAction as R, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: bill });

/** An evidenced (or not) X the GL reversed once: out, its line still linked. */
async function scenario(evidenced = true) {
  const doc = await seedDoc();
  const { je: x, bt } = await seedProvisional({ totalAmount: 115, ...(evidenced ? { evidencedBy: doc } : {}) });
  const bill = await seedInvoice({ documentId: doc, totalAmount: 115 });
  const r1 = String((await inTx(() => reverseJournalEntry(company, x, user))).id);
  return { x, bt, bill, r1 };
}

/** X booked with its line free (or no line at all while it stands) — the cash twice, or a provisional nobody can settle. */
async function broken(s: { x: string; bt: string }) {
  const l = await line(s.bt);
  return (await standing(s.x)) && l.prov === null ? `X standing, line ${String(l.status)} unlinked, ${await settlements(s.x)} settlement(s)` : null;
}

describe('D10 round 2: the provisional\'s state is decided under its chain-head lock', () => {
  it('F1 race (real routes): bank reversal of a dead provisional\'s line vs GL re-reversal + approval', async () => {
    const s = await scenario();
    const between: Record<string, unknown> = {};
    const hook = armBefore(/UPDATE bank_transactions\s+SET status = 'imported'/, async () => {
      between.B = await reReverse(s.r1);
      between.C = await approve(s.bill);
    });
    let a: unknown;
    try { a = await reverseRoute(s.bt); } finally { hook.disarm(); }
    expect(hook.fired()).toBe(true);
    expect(await broken(s), JSON.stringify({ a, between, line: await line(s.bt) })).toBeNull();
  }, 120000);

  for (const order of ['A,B,C', 'B,C,A', 'B,A,C'] as const) {
    it(`F1 control, serial ${order}: never X standing with its line freed`, async () => {
      const s = await scenario();
      const run = { A: () => reverseRoute(s.bt), B: () => reReverse(s.r1), C: () => approve(s.bill) };
      for (const f of order.split(',') as ('A' | 'B' | 'C')[]) await run[f]();
      const l = await line(s.bt);
      expect(!((await settlements(s.x)) > 0 && l.prov === null), JSON.stringify(l)).toBe(true);
    }, 120000);
  }

  it('O-b race: the auto-post undo of a hand-reversed provisional vs a GL re-reversal landing before its reset', async () => {
    const s = await scenario(false);
    const run = String((await pool.query(`INSERT INTO bank_auto_post_runs(company_id,source,min_confidence,amount_cap,posted_count,created_by)
      VALUES($1,'import',0.7,100000,1,$2) RETURNING id`, [company, user])).rows[0].id);
    await pool.query('UPDATE bank_transactions SET auto_post_run_id = $2 WHERE id = $1', [s.bt, run]);
    const between: Record<string, unknown> = {};
    const hook = armBefore(/SET status = 'imported', provisional_je_id = NULL/, async () => {
      between.B = await inTx(() => reverseJournalEntry(company, s.r1, user)).then(() => 'ok', (e: Error) => e.message);
    });
    let out: unknown;
    try { out = await inTx(() => undoRun(company, run, user)); } finally { hook.disarm(); }
    expect(hook.fired()).toBe(true);
    expect(await broken(s), JSON.stringify({ out, between, line: await line(s.bt) })).toBeNull();
  }, 120000);
});
