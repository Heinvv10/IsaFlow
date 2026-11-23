/**
 * Intercompany P4-D, plan (i).1: no double clear. What the receiver may clear for one payer payment is capped by the payer's books (the
 * liveness definer's clearable_total: LEAST(the payment's live allocations, what its standing journal credited the payer's loan account)), and
 * what every message on one payer journal may clear together by that journal's loan credit (journal_clearable), less what the receiver's
 * other standing clearings already cleared. Unapply + re-apply, a payment moved to another linked bill, and a batch journal's members are each
 * cleared once; two accepts of messages that share a cap at the same moment clear once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { CLEAR_REFUSAL_SENTENCES } from '../../../src/modules/accounting/services/intercompany/allocationClearRefusals';
import { acct, asAppUser, co, U, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { bank, clearPayments, plantBatchRow, plantBill, plantPaid, plantPaymentJournal, sendFor } from './allocation.helpers';
import { liveFor } from './allocation-live.helpers';
import { lockWaiter } from './ledger.helpers';
import { accept, bodyFor, clearConnect, clearSetup, ledger, outcomeOf, reapply, sentClearable } from './allocation-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

const already = { accepted: false, status: 'failed', code: 'already_cleared', error: CLEAR_REFUSAL_SENTENCES.already_cleared };
const clearable = async (message: string) => (await pool.query(
  `SELECT live, reason, clearable_total::float8 AS c, journal_clearable::float8 AS j FROM public.intercompany_allocation_message_live($1)`, [message])).rows[0];

describe('what the payer\'s books let be cleared', () => {
  it('the definer says how much: the payment through its loan account; nothing through a bank; part when the journal splits; nothing once not live', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    expect(await liveFor(pool, sent.message)).toMatchObject({ live: true, reason: 'ok' });
    const asA = (m: string) => asAppUser(pool, U.a, co.A, async (q) => (await q.query(
      'SELECT live, reason, clearable_total::float8 AS c, journal_clearable::float8 AS j FROM public.intercompany_allocation_message_live($1)', [m])).rows[0]);
    expect(await asA(sent.message)).toEqual({ live: true, reason: 'ok', c: 400, j: 400 });
    const viaBank = await sentClearable(pool, conn, { leg: bank.b });
    expect(await asA(viaBank.message)).toEqual({ live: true, reason: 'ok', c: 0, j: 0 });
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [sent.allocation]);
    expect(await asA(sent.message)).toEqual({ live: false, reason: 'allocation_gone', c: null, j: null });
    // the table owner has no session: not_found, and no figure
    expect(await clearable(viaBank.message)).toEqual({ live: false, reason: 'not_found', c: null, j: null });
  });
});

describe('a payment is cleared once', () => {
  it('unapply and re-apply to the same bill: the second message is refused already_cleared', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [sent.allocation]);
    const again = await reapply(pool, sent.payment, sent.bill, 400);
    const journals = await ledger.journals(pool);
    expect(outcomeOf(await accept(again.message, bodyFor(sent)))).toMatchObject(already);
    expect(await ledger.journals(pool)).toBe(journals);
    expect(await ledger.open(pool, sent.invoice)).toBeCloseTo(750, 2);
  });

  it('the payment moved to another linked bill (another invoice): refused already_cleared', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [sent.allocation]);
    const other = await plantBill(pool, conn);
    const moved = await reapply(pool, sent.payment, other.bill, 400);
    const journals = await ledger.journals(pool);
    expect(outcomeOf(await accept(moved.message, bodyFor({ invoice: other.invoice, amount: 400 })))).toMatchObject(already);
    expect(await ledger.journals(pool)).toBe(journals);
    expect(await ledger.open(pool, other.invoice)).toBeCloseTo(1150, 2);
  });

  it('a batch journal: its members clear up to its loan credit together, and a member beyond it is refused', async () => {
    const journal = await plantPaymentJournal(pool, 800, { leg: acct.bLoan });
    const batch = await plantBatchRow(pool, { journal });
    const members = [];
    for (const amount of [400, 400, 300]) {
      const b = await plantBill(pool, conn);
      const p = await plantPaid(pool, b.bill, { batch, amount, memberBank: bank.b });
      const out = await sendFor(pool, p.allocation);
      members.push({ ...b, ...p, amount, message: out.message_id as string });
    }
    expect(outcomeOf(await accept(members[0]!.message, bodyFor(members[0]!)))).toMatchObject({ accepted: true });
    expect(outcomeOf(await accept(members[1]!.message, bodyFor(members[1]!)))).toMatchObject({ accepted: true });
    expect(outcomeOf(await accept(members[2]!.message, bodyFor(members[2]!)))).toMatchObject(already);
    expect(await ledger.open(pool, members[2]!.invoice)).toBeCloseTo(1150, 2);
  });

  it('two messages sharing one cap, accepted at the same moment: the first clears, the second waits and is refused', async () => {
    // one payment of 600 through the loan account, split 300 / 300 over two linked bills, and a journal crediting the loan only 300
    const journal = await plantPaymentJournal(pool, 300, { leg: acct.bLoan });
    const b1 = await plantBill(pool, conn);
    const b2 = await plantBill(pool, conn);
    const p = await plantPaid(pool, b1.bill, { amount: 300, journal });
    const second = await reapply(pool, p.payment, b2.bill, 300);
    const first = (await sendFor(pool, p.allocation)).message_id as string;
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM intercompany_messages WHERE id = ANY($1) FOR UPDATE', [[first, second.message]]);
    const both = Promise.all([
      accept(first, bodyFor({ invoice: b1.invoice, amount: 300 })),
      accept(second.message, bodyFor({ invoice: b2.invoice, amount: 300 })),
    ]);
    expect(await lockWaiter(pool)).toBe(true);
    await holder.query('COMMIT');
    holder.release();
    const outs = (await both).map(outcomeOf);
    expect(outs.filter((o) => o.accepted)).toHaveLength(1);
    expect(outs.filter((o) => !o.accepted)).toEqual([expect.objectContaining(already)]);
    expect((await ledger.open(pool, b1.invoice)) + (await ledger.open(pool, b2.invoice))).toBeCloseTo(2300 - 300, 2);
  });
});
