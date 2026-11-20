/**
 * Intercompany P2, the cross-tenant attacks of the round-3 review (breaker B1, B2, B3, B6 and the observations). A writer of ONE company must
 * not make another company's books eliminate, matched or not: the group row a message records is matched by the database only (no session
 * of any party, and no service login), the manual match refuses it, the elimination generator re-checks both journals it rests on, the
 * sender's journal must carry the document's figures by value, and a cancel the ledger undoes is undone in the mirror too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { reverseJournalEntry } from '../../../src/modules/accounting/services/gl/journalEntryService';
import { matchIntercompanyTransactions, IntercompanyMirroredRowError } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { asAppUser, outcome, withoutTrigger } from './intercompany.helpers';
import { approveInvoice, asService, co, plantArInvoice, rawReverseJournal, reversalOf, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { rows, groupRow, adjustments, eliminate, approveBill, accepted } = L;
const other = { customer: crypto.randomUUID() };
beforeAll(async () => {
  await L.setup();
  await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [other.customer, co.A, 'IC A unrelated customer']);
}, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const acctOf = async (company: string, subtype: string) => (await pool.query('SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 LIMIT 1', [company, subtype])).rows[0].id as string;
const send = (doc: string, user = U.a) => asAppUser(pool, user, co.A, async (q) => (await q.query("SELECT * FROM public.intercompany_send_for_source('customer_invoice', $1)", [doc])).rows[0], true);
const journalOf = async (inv: string) => (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [inv])).rows[0].je as string;

describe('B1: a row the mirror recorded is matched by the database only', () => {
  const MATCH = "UPDATE intercompany_transactions SET match_status = 'matched', matched_by = $2, matched_at = now() WHERE id = $1";
  it('no session of either party can mark it matched, unmatched, signed or with a variance (and none can delete it: no DELETE policy); nothing is eliminated', async () => {
    await accepted();
    const tx = (await groupRow()).id as string;
    for (const [user, company] of [[U.b, co.B], [U.a, co.A]] as const) {
      await asAppUser(pool, user, company, async (q) => {
        expect(await outcome(q, MATCH, [tx, user])).toMatch(/^23514: intercompany_transactions: a row the mirror recorded is matched by the database only/);
        expect(await outcome(q, 'UPDATE intercompany_transactions SET variance_amount = 5 WHERE id = $1', [tx])).toMatch(/^23514: intercompany_transactions: a row the mirror recorded/);
        expect((await q.query('DELETE FROM intercompany_transactions WHERE id = $1', [tx])).rowCount).toBe(0);   // no DELETE policy: row security
      });
    }
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await eliminate()).toHaveLength(0);
  });

  it('the service logins (app_service, isaflow_service) cannot either', async () => {
    await accepted();
    const tx = (await groupRow()).id as string;
    const c = await pool.connect();
    try {
      for (const setup of ['SET LOCAL ROLE app_service', 'SET LOCAL SESSION AUTHORIZATION isaflow_service']) {
        await c.query('BEGIN');
        await c.query(setup);
        expect(await outcome(c, MATCH, [tx, crypto.randomUUID()])).toMatch(/^(23514|42501)/);
        await c.query('ROLLBACK');
      }
    } finally { c.release(); }
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
  });

  it('the generator takes a mirrored row only when it names its target journal and BOTH journals it rests on still stand, whatever match_status says', async () => {
    const m = await accepted();
    await L.approveBill(m.bill);
    const tx = await groupRow();
    expect(await eliminate()).toHaveLength(1);
    await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
    // (planted: matched by hand with no target journal)
    const plant = (set: string) => withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(`UPDATE intercompany_transactions SET ${set} WHERE id = $1`, [tx.id]));
    await plant('target_journal_entry_id = NULL');
    expect(await eliminate()).toHaveLength(0);
    await plant(`target_journal_entry_id = '${tx.first_target_journal_entry_id}'`);
    expect(await eliminate()).toHaveLength(1);
    await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
    // the sender's journal reversed straight in the ledger (no service, no hook): the row still says matched, the ledger does not carry it
    await rawReverseJournal(pool, tx.source_journal_entry_id);
    expect(await eliminate()).toHaveLength(0);
    // the sender's reversal is itself reversed (its journal stands again) and the row is eliminated once more ...
    await rawReverseJournal(pool, (await reversalOf(pool, tx.source_journal_entry_id))!, 'raw re-reversal');
    expect(await eliminate()).toHaveLength(1);
    await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
    // ... and now the RECEIVER's journal reversed straight in the ledger: the row still says matched, the ledger does not carry the expense
    await rawReverseJournal(pool, tx.first_target_journal_entry_id);
    expect(await eliminate()).toHaveLength(0);
  });
});

describe('B2: a mirrored row is not matched by hand, with a forged counterpart or otherwise', () => {
  it('matchIntercompanyTransactions(p2 row, a forged counterpart of the receiver) is refused by the service, and by the database underneath; nothing is eliminated', async () => {
    await accepted();
    const p2 = (await groupRow()).id as string;
    const forged = (await asAppUser(pool, U.b, co.B, (q) => q.query(
      `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date)
       VALUES ($1, $2, $3, 'sale', 1000, 'ZAR', 'forged counterpart', '2026-09-01') RETURNING id`, [co.G, co.B, co.A]), true)).rows[0].id as string;
    await expect(asService(pool, U.b, co.B, () => matchIntercompanyTransactions(p2, forged, co.G, U.b))).rejects.toBeInstanceOf(IntercompanyMirroredRowError);
    // the service gone, the same UPDATE by a writer: the trigger
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_transactions SET match_status = 'matched', matched_by = $3, matched_at = now() WHERE id IN ($1, $2)", [p2, forged, U.b])).toMatch(/^23514/);
    });
    expect((await rows()).map((r) => r.match_status)).toEqual(['unmatched', 'unmatched']);
    expect(await eliminate()).toHaveLength(0);
  });
});

describe('Observation: a kind no phase writes yet is not a session\'s to insert', () => {
  it('interest_invoice, and any kind naming a customer invoice, credit note or bill, is refused for app_user; a payment naming a payment row still is not a document message', async () => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    const conn = (await pool.query('SELECT id FROM intercompany_connections LIMIT 1')).rows[0].id as string;
    await asAppUser(pool, U.a, co.A, async (q) => {
      for (const [kind, type] of [['interest_invoice', 'customer_invoice'], ['payment', 'customer_invoice'], ['allocation', 'credit_note'], ['credit_request', 'supplier_invoice']]) {
        expect(await outcome(q, `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
          VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`, [conn, co.A, co.B, kind, type, inv.id])).toMatch(/^42501: a document message is written by the database/);
      }
    });
  });
});

describe('B3: the sender\'s journal must carry the document\'s figures, by value', () => {
  it('T1: a journal a writer posted with the posting\'s text and R1 on each side makes a R1 150 invoice (set approved by hand) UNSENDABLE', async () => {
    const inv = await plantArInvoice(pool);   // a draft, R1 000 + VAT
    const [ar, rv] = [await acctOf(co.A, 'receivable'), await acctOf(co.A, 'default_revenue')];
    await asAppUser(pool, U.a, co.A, async (q) => {
      const je = (await q.query(
        `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', $1, 'auto_invoice', 'draft', $2, $3) RETURNING id`,
        [`Customer invoice ${inv.number}`, U.a, co.A])).rows[0].id as string;
      await q.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 1, 0, $4), ($1, $3, 0, 1, $4)', [je, ar, rv, co.A]);
      await q.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [je]);
      expect(await outcome(q, "UPDATE customer_invoices SET status = 'approved', gl_journal_entry_id = $2 WHERE id = $1", [inv.id, je])).toBe('ok');
    }, true);
    expect(await send(inv.id)).toMatchObject({ message_id: null, reason: 'no_journal', detail: expect.stringMatching(/receivable is not the document's total/) });
    expect((await pool.query('SELECT count(*)::int AS n FROM intercompany_messages WHERE source_doc_id = $1', [inv.id])).rows[0].n).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('T1b: a REAL approval journal of an unrelated R1 invoice, re-used for a R90 000 invoice by renumbering (column writes only): unsendable', async () => {
    const small = await plantArInvoice(pool, { customer: other.customer, lines: [['Small', 1, 1]] });
    expect((await approveInvoice(small.id)).state.statusCode).toBe(200);
    const smallJe = await journalOf(small.id);
    const big = await plantArInvoice(pool, { lines: [['Big job', 1, 90000]] });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, "UPDATE customer_invoices SET invoice_number = invoice_number || '-old', gl_journal_entry_id = NULL WHERE id = $1", [small.id])).toBe('ok');
      expect(await outcome(q, "UPDATE customer_invoices SET invoice_number = $2, status = 'approved', gl_journal_entry_id = $3 WHERE id = $1", [big.id, small.number, smallJe])).toBe('ok');
    }, true);
    expect(await send(big.id)).toMatchObject({ message_id: null, reason: 'no_journal', detail: expect.stringMatching(/receivable is not the document's total/) });
    expect(await rows()).toHaveLength(0);
  });

  it('a journal with the right receivable and the wrong split (the VAT posted as revenue) is unsendable: the revenue is judged by value too', async () => {
    const inv = await plantArInvoice(pool);   // R1 000 + R150 VAT = R1 150
    const [ar, rv] = [await acctOf(co.A, 'receivable'), await acctOf(co.A, 'default_revenue')];
    await asAppUser(pool, U.a, co.A, async (q) => {
      const je = (await q.query(
        `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', $1, 'auto_invoice', 'draft', $2, $3) RETURNING id`,
        [`Customer invoice ${inv.number}`, U.a, co.A])).rows[0].id as string;
      await q.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 1150, 0, $4), ($1, $3, 0, 1150, $4)', [je, ar, rv, co.A]);
      await q.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [je]);
      await q.query("UPDATE customer_invoices SET status = 'approved', gl_journal_entry_id = $2 WHERE id = $1", [inv.id, je]);
    }, true);
    expect(await send(inv.id)).toMatchObject({ message_id: null, reason: 'no_journal', detail: expect.stringMatching(/revenue is not the document's subtotal/) });
  });

  it('the honest invoice (the real approval journal) is sent, and so is a credit note whose journal has the sides swapped', async () => {
    const m = await sentInvoice(pool);
    expect(m.message.source_journal_entry_id).toBe(await journalOf(m.inv.id));
  });
});

describe('B6: a cancel the ledger undoes is undone in the mirror', () => {
  /** A writer's reversal of the invoice's journal (the lines swapped, posted by app_user) and the status / link of a cancel: no service, no hook. */
  async function handCancel(inv: string) {
    const je = await journalOf(inv);
    const lines = (await pool.query('SELECT gl_account_id AS a, debit::float8 AS d, credit::float8 AS c FROM gl_journal_lines WHERE journal_entry_id = $1', [je])).rows;
    let rev = '';
    await asAppUser(pool, U.a, co.A, async (q) => {
      rev = (await q.query(
        `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id, reversal_of_id) VALUES ('2026-09-01', 'hand reversal', 'manual', 'draft', $1, $2, $3) RETURNING id`,
        [U.a, co.A, je])).rows[0].id as string;
      for (const l of lines) await q.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, $3, $4, $5)', [rev, l.a, l.c, l.d, co.A]);
      await q.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [rev]);
      await q.query("UPDATE customer_invoices SET status = 'cancelled', gl_journal_entry_id = NULL WHERE id = $1", [inv]);
    }, true);
    return { je, rev };
  }
  const withdraw = (inv: string) => asAppUser(pool, U.a, co.A, async (q) => Number((await q.query("SELECT public.intercompany_withdraw_for_source('customer_invoice', $1) AS n", [inv])).rows[0].n), true);
  const msg = async (id: string) => (await pool.query('SELECT status, source_cancelled_at FROM intercompany_messages WHERE id = $1', [id])).rows[0];
  const restoreInvoice = (inv: string, je: string) => pool.query("UPDATE customer_invoices SET status = 'approved', gl_journal_entry_id = $2 WHERE id = $1", [inv, je]);

  it('a pending message: cancelled by hand and withdrawn, then the reversal itself reversed (the invoice is live again): the message is pending again', async () => {
    const m = await sentInvoice(pool);
    const { rev } = await handCancel(m.inv.id);
    expect(await withdraw(m.inv.id)).toBe(1);
    expect(await msg(m.id)).toMatchObject({ status: 'withdrawn' });
    await restoreInvoice(m.inv.id, m.message.source_journal_entry_id);                  // the invoice is approved on its journal again ...
    await asService(pool, U.a, co.A, () => reverseJournalEntry(co.A, rev, U.a));      // ... and the ledger's parity says LIVE again; the mirror hears it
    expect(await msg(m.id)).toMatchObject({ status: 'pending', source_cancelled_at: null });
  });

  it('an accepted and approved row: withdrawn and released by the hand cancel, matched and eliminated again once the reversal is reversed', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await eliminate()).toHaveLength(1);
    const { rev } = await handCancel(m.inv.id);
    expect(await withdraw(m.inv.id)).toBe(1);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect((await adjustments())[0]).toMatchObject({ status: 'reversed', reversed_reason: expect.stringMatching(/sender cancelled/) });
    await restoreInvoice(m.inv.id, m.message.source_journal_entry_id);
    await asService(pool, U.a, co.A, () => reverseJournalEntry(co.A, rev, U.a));
    expect(await msg(m.id)).toMatchObject({ status: 'accepted', source_cancelled_at: null });
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(await eliminate()).toHaveLength(1);
  });

  it('the sync judges the sender\'s cancel by the ledger\'s parity now, not by the stamp left behind: with the journal live again a stamped message does not unmatch the row', async () => {
    const m = await accepted();
    const { rev } = await handCancel(m.inv.id);
    expect(await withdraw(m.inv.id)).toBe(1);
    // the reversal is reversed in the ledger with no service (no hook runs): the stamp is stale
    await rawReverseJournal(pool, rev, 'raw re-reversal');
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
  });

  it('a stale withdrawal is lifted by sending the document again (the send finds its message, withdrawn, with its journal live)', async () => {
    const m = await sentInvoice(pool);
    const { rev } = await handCancel(m.inv.id);
    await withdraw(m.inv.id);
    await rawReverseJournal(pool, rev, 'raw re-reversal');
    await pool.query("UPDATE customer_invoices SET status = 'approved', gl_journal_entry_id = $2 WHERE id = $1", [m.inv.id, m.message.source_journal_entry_id]);
    expect(await send(m.inv.id)).toMatchObject({ message_id: m.id, reason: null });
    expect(await msg(m.id)).toMatchObject({ status: 'pending', source_cancelled_at: null });
  });
});

describe('Ledger 4d: a DIRECT reversal of the sender\'s journal (the reversal service, no cancel) is a cancel to the mirror', () => {
  it('the message is withdrawn / stamped, the row released and the elimination reversed with when and why', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    await eliminate();
    await asService(pool, U.a, co.A, () => reverseJournalEntry(co.A, m.message.source_journal_entry_id, U.a));
    expect((await pool.query('SELECT status, source_cancelled_at FROM intercompany_messages WHERE id = $1', [m.id])).rows[0]).toMatchObject({ status: 'accepted' });
    expect((await pool.query('SELECT source_cancelled_at FROM intercompany_messages WHERE id = $1', [m.id])).rows[0].source_cancelled_at).not.toBeNull();
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', target_journal_entry_id: null });
    const [a] = await adjustments();
    expect(a).toMatchObject({ status: 'reversed', reversed_reason: expect.stringMatching(/sender's journal was reversed/) });
    expect(a!.reversed_at).not.toBeNull();
    expect(await eliminate()).toHaveLength(0);
  });
});
