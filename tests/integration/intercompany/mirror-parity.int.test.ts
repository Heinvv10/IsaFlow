/**
 * Intercompany P2, the ledger's reversal parity is judged BY VALUE (round-4 breaker R1, R1b, R2, R3, R6). `reversal_of_id` is a column a writer
 * can set on a posted journal, so a link counts as a reversal only if it is posted, of the same company, and its lines are the exact negation of
 * the journal it claims to reverse; and a revival (message, send, row) also needs the document to be live in its books. A forged "reversal of the
 * reversal" revives nothing, re-matches nothing and releases nothing. And the revivals that ARE true now happen: a receiver's reversal that is
 * reversed matches its row again, and a variance is judged afresh when the sender's cancel is undone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { reverseJournalEntry } from '../../../src/modules/accounting/services/gl/journalEntryService';
import { cancelCustomerInvoice } from '../../../src/modules/accounting/services/ar/customerInvoiceCancelService';
import { asAppUser, outcome } from './intercompany.helpers';
import { asService, co, rawReverseJournal, reversalOf, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { groupRow, derived, approveBill, accepted } = L;
beforeAll(L.setup, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const acctOf = async (company: string, subtype: string) => (await pool.query('SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 LIMIT 1', [company, subtype])).rows[0].id as string;
const jeOf = async (inv: string) => (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [inv])).rows[0].je as string | null;
const msg = async (id: string) => (await pool.query('SELECT status, source_cancelled_at FROM intercompany_messages WHERE id = $1', [id])).rows[0];
const chain = async (je: string, company: string) => Number((await pool.query('SELECT public.intercompany_journal_chain_length($1, $2) AS n', [je, company])).rows[0].n);
const chainChanged = (user: string, company: string, je: string) =>
  asAppUser(pool, user, company, async (q) => Number((await q.query('SELECT public.intercompany_journal_chain_changed($1) AS n', [je])).rows[0].n), true);
const send = (doc: string) => asAppUser(pool, U.a, co.A, async (q) => (await q.query("SELECT * FROM public.intercompany_send_for_source('customer_invoice', $1)", [doc])).rows[0], true);

/**
 * A journal a WRITER posts (app_user): any source / text, linked by reversal_of_id AFTER it is posted (an INSERT carrying one is refused by
 * 1018). Without 1018 the link is set; with it a link that is not a true negation is refused (a 23514), so the forgery never exists. Either
 * outcome leaves the mirror unmoved, which is what the cases assert; the outcome is printed. lines: [account, debit, credit].
 */
async function forge(q: PoolClient, company: string, user: string, lines: [string, number, number][], reversalOf: string | null): Promise<string> {
  const id = (await q.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', 'forged', 'manual', 'draft', $1, $2) RETURNING id`,
    [user, company])).rows[0].id as string;
  for (const [a, d, c] of lines) await q.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, $3, $4, $5)', [id, a, d, c, company]);
  await q.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
  if (reversalOf) {
    // 1018 first asks that the link is made in the transaction that claimed the reversed journal (the stamp a writer may write) and created the
    // contra; claim it here so the refusal judged is the one these cases are about (the lines are no negation), not the born-here one
    await q.query('UPDATE gl_journal_entries SET reversed_by = $2, reversed_at = now() WHERE id = $1', [reversalOf, user]);
    const link = await outcome(q, 'UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [id, reversalOf]);
    expect(link).toMatch(/^(ok|23514: gl_journal_entries: )/);
    process.stderr.write(`[parity] forged link: ${link === 'ok' ? 'set (no 1018)' : `refused (1018): ${link}`}\n`);
  }
  return id;
}
/** A fixture's true reversal of `je`, or false when the ledger refuses it (#1691 round 3: a chain whose head a cancelled document held). */
async function tryRawReverse(je: string, description: string): Promise<boolean> {
  try {
    await rawReverseJournal(pool, je, description);
    return true;
  } catch (err) {
    expect((err as { code?: string }).code).toBe('23514');
    process.stderr.write(`[parity] re-reversal refused: ${(err as Error).message}\n`);
    return false;
  }
}
/** The empty-value "reversal": a debit and a credit of R1 on one account (nets to nothing). */
const forgedEmpty = async (company: string, user: string, subtype: string, parent: string | null) => {
  const a = await acctOf(company, subtype);
  let id = '';
  await asAppUser(pool, user, company, async (q) => { id = await forge(q, company, user, [[a, 1, 0], [a, 0, 1]], parent); }, true);
  return id;
};

describe('a link counts as a reversal only by value', () => {
  it('lines_negate: the exact negation only (account by account, to the cent), of a journal with something in it', async () => {
    const m = await sentInvoice(pool);
    const je = (await jeOf(m.inv.id))!;
    const good = await rawReverseJournal(pool, je);
    const ok = async (c: string, p: string) => (await pool.query('SELECT public.intercompany_lines_negate($1, $2) AS ok', [c, p])).rows[0].ok as boolean;
    expect(await ok(good, je)).toBe(true);
    const ar = await acctOf(co.A, 'receivable');
    let small = '';
    const rv = await acctOf(co.A, 'default_revenue');
    await asAppUser(pool, U.a, co.A, async (q) => { small = await forge(q, co.A, U.a, [[ar, 0, 1.15], [rv, 1.15, 0]], null); }, true);
    expect(await ok(small, je)).toBe(false);                       // the right sides, a fraction of the amount
    expect(await ok(je, good)).toBe(true);                         // (negation is symmetric)
    const empty = await forgedEmpty(co.A, U.a, 'receivable', null);
    expect(await ok(empty, je)).toBe(false);                       // nets to nothing
    expect(await ok(good, empty)).toBe(false);                     // a parent with nothing in it has nothing to negate
    expect(await ok(await forgedEmpty(co.A, U.a, 'receivable', null), empty)).toBe(false);   // ... even to a child that nets to nothing too
  });
});

describe('sender: a forged re-reversal revives nothing (R1, R1b, R3)', () => {
  it('R1: after a real cancel, a forged EMPTY "reversal of the reversal" does not revive the stamp, re-match the row or restore the derived elimination', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await derived()).toHaveLength(1);
    const je = (await jeOf(m.inv.id))!;
    await asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, m.inv.id, U.a, { allowReversal: true }));
    const r1 = (await reversalOf(pool, je))!;
    const forged = await forgedEmpty(co.A, U.a, 'receivable', r1);
    expect(await chain(je, co.A)).toBe(2);                          // the forged link is not a link
    await chainChanged(U.a, co.A, forged);
    expect((await msg(m.id)).source_cancelled_at).not.toBeNull();
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await derived()).toHaveLength(0);
  });

  it('R1b: an existing posted journal re-pointed at the reversal (UPDATE reversal_of_id) is no link either', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const je = (await jeOf(m.inv.id))!;
    await asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, m.inv.id, U.a, { allowReversal: true }));
    const r1 = (await reversalOf(pool, je))!;
    const ar = await acctOf(co.A, 'receivable');
    let old = '';
    await asAppUser(pool, U.a, co.A, async (q) => {
      old = await forge(q, co.A, U.a, [[ar, 5, 0], [ar, 0, 5]], null);
      // 1018 first asks that the link is made in the transaction that claimed the reversed journal and created the contra; claim r1 here (a stamp a writer
      // may write) so the refusal that is judged is the one this case is about: the lines are no negation
      await q.query('UPDATE gl_journal_entries SET reversed_by = $2, reversed_at = now() WHERE id = $1', [r1, U.a]);
      const link = await outcome(q, 'UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [old, r1]);   // a writer can (without 1018), or 1018 refuses it
      expect(link).toMatch(/^(ok|23514: gl_journal_entries: a reversal's lines must be the exact negation)/);
      process.stderr.write(`[parity R1b] re-point: ${link === 'ok' ? 'set (no 1018)' : `refused (1018): ${link}`}\n`);
    }, true);
    await chainChanged(U.a, co.A, old);
    expect(await chain(je, co.A)).toBe(2);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await derived()).toHaveLength(0);
  });

  it('a TRUE reversal of the reversal on a CANCELLED invoice: the inbox state is not revived (the document is not live in its books); the figure follows the ledgers, which carry the revenue again', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const je = (await jeOf(m.inv.id))!;
    await asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, m.inv.id, U.a, { allowReversal: true }));
    expect(await derived()).toHaveLength(0);
    const r1 = (await reversalOf(pool, je))!;
    // by value a real reversal: the chain is odd again. #1691 round 3 refuses re-instating a chain whose head a cancelled document held: then
    // the ledger does not carry the revenue again and nothing is eliminated.
    const reinstated = await tryRawReverse(r1, 'valid re-reversal');
    expect(await chain(je, co.A)).toBe(reinstated ? 3 : 2);
    if (reinstated) await chainChanged(U.a, co.A, (await reversalOf(pool, r1))!);
    expect((await msg(m.id)).source_cancelled_at).not.toBeNull();   // the invoice is cancelled and unlinked: not revived
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await derived()).toHaveLength(reinstated ? 1 : 0);   // (re-instated, A's ledger carries the revenue again and B's the expense: the elimination is what both books show)
  });

  it('R3: the send does not re-pend a withdrawn message of a cancelled invoice (forged re-reversal, or a true one)', async () => {
    for (const how of ['forged', 'true'] as const) {
      await L.reset();
      const sent = await sentInvoice(pool);
      const je = (await jeOf(sent.inv.id))!;
      await asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, sent.inv.id, U.a, { allowReversal: true }));
      expect(await msg(sent.id)).toMatchObject({ status: 'withdrawn' });
      const r1 = (await reversalOf(pool, je))!;
      if (how === 'forged') await forgedEmpty(co.A, U.a, 'receivable', r1); else await tryRawReverse(r1, 'valid re-reversal');
      expect(await send(sent.inv.id)).toMatchObject({ message_id: null });
      expect(await msg(sent.id)).toMatchObject({ status: 'withdrawn' });
    }
  });
});

describe('receiver: forged links, true revivals, and an insider\'s forged "reversal" (R2, R6, LOW)', () => {
  it('R2: after the bill\'s journal is reversed, a forged empty re-reversal does not re-match the row (zero expense stays out of the eliminations)', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const bj = (await groupRow()).target_journal_entry_id as string;
    await asService(pool, U.b, co.B, () => reverseJournalEntry(co.B, bj, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    const forged = await forgedEmpty(co.B, U.b, 'payable', (await reversalOf(pool, bj))!);
    await chainChanged(U.b, co.B, forged);
    expect(await L.sync(U.b, co.B, m.bill)).not.toBe('matched');   // (its bill is still approved on a reversed journal: a variance, never a match)
    expect(await derived()).toHaveLength(0);
  });

  it('R6: a forged empty "reversal" of the receiver\'s own journal releases nothing (B cannot un-eliminate a real expense by hand)', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const bj = (await groupRow()).target_journal_entry_id as string;
    const forged = await forgedEmpty(co.B, U.b, 'payable', bj);
    await chainChanged(U.b, co.B, forged);
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(await derived()).toHaveLength(1);
  });

  it('the receiver\'s reversal that is itself reversed (a TRUE re-reversal, its bill still approved on that journal) matches the row again', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const bj = (await groupRow()).target_journal_entry_id as string;
    await asService(pool, U.b, co.B, () => reverseJournalEntry(co.B, bj, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    await asService(pool, U.b, co.B, async () => reverseJournalEntry(co.B, (await reversalOf(pool, bj))!, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'matched', target_journal_entry_id: bj });
    expect(await derived()).toHaveLength(1);
  });

  it('a VARIANCE is judged afresh when the sender\'s cancel is undone: the row comes back a variance with its reason, never a match', async () => {
    const m = await accepted();
    await pool.query("UPDATE supplier_invoice_items SET unit_price = 250, line_total = 500, tax_amount = 75 WHERE supplier_invoice_id = $1 AND description = 'Fibre install'", [m.bill]);
    await pool.query('UPDATE supplier_invoices SET subtotal = 900, tax_amount = 135, total_amount = 1035 WHERE id = $1', [m.bill]);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'variance' });
    const je = m.message.source_journal_entry_id as string;
    // The sender's journal is reversed by the service with the invoice NOT cancelled: 1018 refuses the service a re-reversal of a cancelled document's
    // reversal, but a plain reversal and its reversal are allowed, and the mirror hears both the same way (the chain's parity, not the document's status).
    await asService(pool, U.a, co.A, () => reverseJournalEntry(co.A, je, U.a));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', variance_reason: null });
    await asService(pool, U.a, co.A, async () => reverseJournalEntry(co.A, (await reversalOf(pool, je))!, U.a));
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/not the sender's amount/) });
    expect(await derived()).toHaveLength(0);
  });
});
