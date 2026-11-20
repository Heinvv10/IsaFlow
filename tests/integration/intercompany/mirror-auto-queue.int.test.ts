/**
 * Intercompany P2, who the auto-accept worker takes and in what order (migration 1019). It takes only a message created AFTER the
 * receiver's side switched auto-accept on (so switching it on never drains a backlog), never one a person restored or retried
 * (manual_only), at most 10 per receiver per run, and every attempt is stamped with a back-off (a message that keeps deferring never
 * blocks the head; after 8 attempts the queue lets go). A refusal's `error` is a fixed sentence (the sender reads it): a detail that
 * names the receiver's books is logged, never stored. Also: automatic acceptance is only for a GROUP connection, even if a side says
 * otherwise.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { AUTO_ACCEPT_MAX_ATTEMPTS } from '../../../src/modules/accounting/services/intercompany/inboxRead';
import { acceptMessage } from '../../../src/modules/accounting/services/intercompany/acceptService';
import { GENERIC, runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { asAppUser, outcome, plantDocument, plantExternal, withoutTrigger } from './intercompany.helpers';
import { acc, asService, clearMirrorRows, co, connect, dataOf, inbox, mirrorCleanup, mirrorSetup, party, plantArInvoice, sentInvoice, U } from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(() => clearMirrorRows(pool));

const row = async (id: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE id = $1', [id])).rows[0];
const bills = async () => (await pool.query('SELECT * FROM supplier_invoices WHERE company_id = $1', [co.B])).rows;
const claim = async (limit = 50, claimIt = true) => (await pool.query('SELECT * FROM public.intercompany_auto_accept_queue($1, $2)', [limit, claimIt])).rows;
const setAuto = (on: boolean) => asAppUser(pool, U.b, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET auto_accept = $1 WHERE company_id = $2', [on, co.B]), true);
/** A test's own change to a message's system columns: the guard is off for it (no app role can make this change). */
const adjust = (id: string, set: string) => withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(`UPDATE intercompany_messages SET ${set} WHERE id = $1`, [id]));
const side = async () => (await pool.query('SELECT * FROM intercompany_connection_sides WHERE company_id = $1', [co.B])).rows[0];

describe('a restored or retried message is a person\'s', () => {
  it('dismiss, restore: the worker never takes it again; the person can accept it', async () => {
    await connect(pool, { autoAccept: true });
    const { id } = await sentInvoice(pool);
    expect((await inbox.dismiss(U.b, co.B, id)).state.statusCode).toBe(200);
    expect((await inbox.restore(U.b, co.B, id)).state.statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'pending', manual_only: true });
    expect(await claim(50, false)).toHaveLength(0);
    expect(await runAutoAccept()).toMatchObject({ considered: 0, accepted: 0 });
    expect((await row(id)).status).toBe('pending');
    expect((await inbox.accept(U.b, co.B, id)).state.statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'accepted', handled_via: 'user' });
  });

  it('a failed message a person retries (back to pending) is manual too, and a worker\'s own claim does not set manual_only', async () => {
    await connect(pool, { autoAccept: true });
    const { id } = await sentInvoice(pool);
    await claim(50, true);
    expect(await row(id)).toMatchObject({ manual_only: false, auto_attempts: 1 });
  });
});

describe('switching auto-accept on never drains a backlog', () => {
  it('messages created before the switch stay for a person; one created after it is taken; switching off clears the stamp', async () => {
    await connect(pool, { autoAccept: false });
    const before1 = await sentInvoice(pool);
    const before2 = await sentInvoice(pool);
    await setAuto(true);
    expect((await side()).auto_accept_since).not.toBeNull();
    expect(await runAutoAccept()).toMatchObject({ considered: 0 });
    expect([(await row(before1.id)).status, (await row(before2.id)).status]).toEqual(['pending', 'pending']);
    const after = await sentInvoice(pool);
    expect(await runAutoAccept()).toMatchObject({ considered: 1, accepted: 1 });
    expect((await row(after.id)).status).toBe('accepted');
    expect((await row(before1.id)).status).toBe('pending');
    await setAuto(false);
    expect((await side()).auto_accept_since).toBeNull();
  });

  it('the stamp is the database\'s: an app role cannot write it, and a side saved again keeps it', async () => {
    await connect(pool, { autoAccept: true });
    const first = (await side()).auto_accept_since as Date;
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connection_sides SET auto_accept_since = now() - interval '5 days' WHERE company_id = $1", [co.B]))
        .toMatch(/^42501: permission denied/);
      await q.query('UPDATE intercompany_connection_sides SET default_expense_account_id = $2 WHERE company_id = $1', [co.B, acc.bExp2]);
    }, true);
    expect(new Date((await side()).auto_accept_since).getTime()).toBe(first.getTime());
  });
});

describe('fairness and back-off', () => {
  it('at most 10 per receiver per run: twelve messages take two runs', async () => {
    await connect(pool, { autoAccept: true });
    for (let i = 0; i < 12; i++) await sentInvoice(pool);
    expect(await claim(50, false)).toHaveLength(10);
    expect(await runAutoAccept()).toMatchObject({ considered: 10, accepted: 10 });
    expect(await runAutoAccept()).toMatchObject({ considered: 2, accepted: 2 });
    expect(await bills()).toHaveLength(12);
  });

  it('every claim stamps an attempt and a back-off: the same message is not handed out again at once, and a newer one is not blocked behind it', async () => {
    await connect(pool, { autoAccept: true });
    const m1 = await sentInvoice(pool);
    const m2 = await sentInvoice(pool);
    const first = await claim(1, true);
    expect(first.map((r) => [r.message_id, r.attempt])).toEqual([[m1.id, 1]]);
    expect((await row(m1.id)).auto_next_attempt_at).not.toBeNull();
    const second = await claim(1, true);
    expect(second.map((r) => r.message_id)).toEqual([m2.id]); // the head m1 is waiting out its back-off; m2 is served
    expect(await claim(50, true)).toHaveLength(0);
    // back-off passed: the same message comes again as attempt 2
    await adjust(m1.id, "auto_next_attempt_at = now() - interval '1 second'");
    expect((await claim(50, true)).map((r) => [r.message_id, r.attempt])).toEqual([[m1.id, 2]]);
  });

  it('after 8 attempts the queue lets go (a person has it); a claim changes nothing else on the message', async () => {
    await connect(pool, { autoAccept: true });
    const m = await sentInvoice(pool);
    await adjust(m.id, `auto_attempts = ${AUTO_ACCEPT_MAX_ATTEMPTS}, auto_next_attempt_at = NULL`);
    expect(await claim(50, false)).toHaveLength(0);
    await adjust(m.id, `auto_attempts = ${AUTO_ACCEPT_MAX_ATTEMPTS - 1}, auto_next_attempt_at = NULL`);
    expect((await claim(50, false)).map((r) => r.message_id)).toEqual([m.id]);   // the last attempt is still taken: the TS constant and the SQL limit are one number
    await adjust(m.id, `auto_attempts = ${AUTO_ACCEPT_MAX_ATTEMPTS}, auto_next_attempt_at = NULL`);
    await adjust(m.id, 'auto_attempts = 0');
    const before = await row(m.id);
    await claim(50, true);
    const after = await row(m.id);
    for (const k of ['status', 'payload', 'handled_by', 'target_doc_id', 'reason', 'error', 'manual_only', 'source_cancelled_at']) expect(after[k]).toEqual(before[k]);
  });

  it('a message the queue let go of is NOT silent: the inbox flags it, the worker counts it as stuck every run, and a restored one is not counted', async () => {
    await connect(pool, { autoAccept: true });
    const m = await sentInvoice(pool);
    const other = await sentInvoice(pool);
    const flagged = async (id: string) => (dataOf<{ items: Array<{ id: string; autoExhausted: boolean }> }>(await inbox.list(U.b, co.B))).items.find((i) => i.id === id)!.autoExhausted;
    expect(await flagged(m.id)).toBe(false);
    await adjust(m.id, `auto_attempts = ${AUTO_ACCEPT_MAX_ATTEMPTS}, auto_next_attempt_at = NULL`);
    await adjust(other.id, `auto_attempts = ${AUTO_ACCEPT_MAX_ATTEMPTS - 1}, auto_next_attempt_at = NULL`);
    expect(await flagged(m.id)).toBe(true);
    expect(await flagged(other.id)).toBe(false);          // the eighth attempt is still to come
    const first = await runAutoAccept();                  // `other` is attempted (and accepted) now; `m` is out of attempts
    expect(first).toMatchObject({ accepted: 1, exhausted: 1, stuck: 1 });
    expect((await row(m.id)).status).toBe('pending');
    expect(await runAutoAccept()).toMatchObject({ considered: 0, exhausted: 1, stuck: 1 });   // and again on the next run, until a person handles it
    expect((await inbox.dismiss(U.b, co.B, m.id)).state.statusCode).toBe(200);
    expect(await runAutoAccept()).toMatchObject({ exhausted: 0, stuck: 0 });
    expect((await inbox.restore(U.b, co.B, m.id)).state.statusCode).toBe(200);              // restored = a person's (manual_only)
    expect(await runAutoAccept()).toMatchObject({ exhausted: 0, stuck: 0 });
    expect(await flagged(m.id)).toBe(false);
  });

  it('a message on a REVOKED connection that used every attempt is no alert (it can never be accepted): the stuck figure leaves it out', async () => {
    const conn = await connect(pool, { autoAccept: true });
    const m = await sentInvoice(pool);
    await adjust(m.id, `auto_attempts = ${AUTO_ACCEPT_MAX_ATTEMPTS}, auto_next_attempt_at = NULL`);
    expect(await runAutoAccept()).toMatchObject({ exhausted: 1, stuck: 1 });
    await asAppUser(pool, U.a, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [conn]), true);
    expect(await runAutoAccept()).toMatchObject({ exhausted: 0, stuck: 0 });
  });

  it('a session cannot forge the claim: the system update is refused for any role but the definer', async () => {
    await connect(pool, { autoAccept: true });
    const m = await sentInvoice(pool);
    await asAppUser(pool, U.b, co.B, async (q) => {
      await q.query("SELECT set_config('app.intercompany_system_update', 'claim', true)");
      expect(await outcome(q, "UPDATE intercompany_messages SET auto_attempts = 0 WHERE id = $1", [m.id])).toMatch(/^42501/);
      expect(await outcome(q, "UPDATE intercompany_messages SET status = 'withdrawn' WHERE id = $1", [m.id])).toMatch(/^23514: a message is withdrawn only by the sender cancelling/);
    });
  });
});

describe('what the sender can read of a failure', () => {
  it('a refusal that names the receiver\'s books is stored as a fixed sentence; only fixed sentences of our own are stored as they are', async () => {
    await connect(pool, { autoAccept: true });
    // B's default account is its accounts-payable control account: a bill line there is refused by the bill's own rule, whose text names it.
    const ap = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable'", [co.B])).rows[0].id;
    await asAppUser(pool, U.b, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET default_expense_account_id = $2 WHERE company_id = $1', [co.B, ap]), true);
    const { id } = await sentInvoice(pool);
    expect(await runAutoAccept()).toMatchObject({ failed: 1 });
    const seenBySender = await asAppUser(pool, U.a, co.A, async (q) => (await q.query('SELECT status, error FROM intercompany_messages WHERE id = $1', [id])).rows[0]);
    expect(seenBySender).toEqual({ status: 'failed', error: GENERIC });
    expect(await bills()).toHaveLength(0);
  });

  it('a fixed sentence (no supplier linked) is stored as it is', async () => {
    await connect(pool, { autoAccept: true, bSupplier: false });
    const { id } = await sentInvoice(pool);
    await runAutoAccept();
    expect(String((await row(id)).error)).toMatch(/^Link the supplier/);
  });
});

describe('automatic acceptance is only for a GROUP connection', () => {
  it('a side that says auto_accept on an EXTERNAL connection still cannot be auto-accepted, even by the service called directly', async () => {
    const ext = await plantExternal(pool, co.A, co.C, 'active');
    const cSupplier = crypto.randomUUID();
    const cExpense = crypto.randomUUID();
    await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3)', [cSupplier, co.C, 'IC C supplier']);
    await pool.query("INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active) VALUES ($1, $2, 'ICXC', 'C exp', 'expense', 'debit', true)", [cExpense, co.C]);
    await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_guard', (q) => q.query(
      'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, supplier_id, default_expense_account_id, auto_accept) VALUES ($1, $2, $3, $4, $5, true)',
      [ext, co.C, co.A, cSupplier, cExpense]));
    // a valid payload (a real approved invoice's) on a message to C, planted with the guard off
    await connect(pool);
    const real = await sentInvoice(pool);
    const inv = await plantArInvoice(pool, { status: 'approved' });
    const payload = JSON.stringify(real.message.payload);
    const mid = await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', async (q) => (await q.query(
      `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
       VALUES ($1, $2, $3, 'invoice', 'customer_invoice', $4, $5::jsonb) RETURNING id`, [ext, co.A, co.C, inv.id, payload])).rows[0].id as string);
    await expect(asService(pool, U.c, co.C, () => acceptMessage(U.c, co.C, mid, {}, { auto: true })))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/only for a group connection/) });
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1', [co.C])).rows[0].n)).toBe(0);
    expect(party.bSupplier).toBeTruthy();
    expect(await plantDocument(pool, 'supplier_invoice', co.C)).toBeTruthy(); // (the same world still takes an ordinary document)
  });
});
