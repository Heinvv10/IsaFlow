/**
 * Intercompany P4-D, the database side (migration 1027). The messages guard accepts an `allocation` only with the clearing posted for it
 * (`intercompany_allocation_target_ok`): a direct UPDATE to accepted (the #1788 hole C pinned) is refused 23514, and so is a forged target
 * (a contra receipt made by hand without this message's stamp, another amount, another message's receipt, a not-live message), or a target set
 * on any other transition. The exact clearing is accepted (the guard holds the shape, not who wrote it). The liveness definer is replaced,
 * registered with its new hash, owned by migration_admin; PUBLIC can execute none of the four functions (round 1: the cap helper is gone,
 * the definer answers the caps itself; the advisory-lock and loan-class helpers are new).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { settleDocumentByContra } from '../../../src/modules/accounting/services/core/contraSettlementPosting';
import { acct, asAppUser, co, outcome, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments, plantBill } from './allocation.helpers';
import { accept, bodyFor, clearConnect, clearSetup, ledger, loan, outcomeOf, reapply, sentClearable } from './allocation-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

/** A contra receipt of A for the invoice made by hand (the settle-by-contra path, not the clearing), optionally stamped. */
async function manualContra(invoice: string, amount: number, stamp: string | null = null): Promise<string> {
  const posted = await asService(pool, U.a, co.A, () => settleDocumentByContra({
    companyId: co.A, subledger: 'ar', documentId: invoice, contraAccountId: acct.aLoan, amount, date: '2026-09-01', reason: 'by hand',
    actor: { userId: U.a, approverUserId: U.a, postingAgent: 'mcp:settle_by_contra:v1' },
  }));
  if (stamp) await pool.query('UPDATE customer_payments SET bank_reference = $2 WHERE id = $1', [posted.paymentId, stamp]);
  return posted.paymentId;
}

/** Run `fn` with the posted-line freezes of gl_journal_lines off for the transaction (a superuser's DDL; each is back ON ALWAYS at COMMIT). */
async function withLinesUnfrozen(fn: (q: PoolClient) => Promise<void>): Promise<void> {
  const triggers = ['trg_gl_jl_posted_frozen', 'trg_gl_jl_posted_set_frozen', 'trg_gl_jl_posted_balanced'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of triggers) await client.query(`ALTER TABLE gl_journal_lines DISABLE TRIGGER ${t}`);
    await fn(client);
    for (const t of triggers) await client.query(`ALTER TABLE gl_journal_lines ENABLE ALWAYS TRIGGER ${t}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const acceptDirect = (q: PoolClient, message: string, target: string | null) => outcome(q,
  "UPDATE intercompany_messages SET status = 'accepted', target_doc_type = CASE WHEN $2::uuid IS NULL THEN NULL ELSE 'customer_payment' END, target_doc_id = $2 WHERE id = $1",
  [message, target]);
const REFUSED = /^23514: an allocation message is accepted with the clearing posted for it/;

describe('the guard holds an accepted allocation to its clearing', () => {
  it('a direct UPDATE to accepted with no target is refused (the hole C pinned is closed)', async () => {
    const sent = await sentClearable(pool, conn);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await acceptDirect(q, sent.message, null)).toMatch(REFUSED); });
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'pending' });
  });

  it('a forged target is refused: a hand-made contra receipt without the stamp, one stamped but of another amount, one stamped for another message', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const plain = await manualContra(sent.invoice, 400);
    const wrongAmount = await manualContra(sent.invoice, 300, `IC:${sent.message}`);
    const otherStamp = await manualContra(sent.invoice, 400, `IC:${crypto.randomUUID()}`);
    await asAppUser(pool, U.a, co.A, async (q) => {
      for (const target of [plain, wrongAmount, otherStamp, crypto.randomUUID()]) expect(await acceptDirect(q, sent.message, target)).toMatch(REFUSED);
    });
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'pending', target_doc_id: null });
  });

  it("another message's clearing receipt is refused as a target, and the exact clearing of a message that is no longer live is refused", async () => {
    const one = await sentClearable(pool, conn, { amount: 400 });
    const two = await sentClearable(pool, conn, { amount: 400 });
    const first = outcomeOf(await accept(one.message, bodyFor(one)));
    const exact = await manualContra(two.invoice, 400, `IC:${two.message}`);
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [two.allocation]);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await acceptDirect(q, two.message, first.paymentId!)).toMatch(/^23514/);
      expect(await acceptDirect(q, two.message, exact)).toMatch(REFUSED);
    });
  });

  it('the exact clearing (stamped, the amount, the invoice, DR loan / CR receivable) of a live message within its cap is accepted', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const exact = await manualContra(sent.invoice, 400, `IC:${sent.message}`);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await acceptDirect(q, sent.message, exact)).toBe('ok'); }, true);
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'accepted', target_doc_id: exact });
  });

  it('the exact clearing of a second message for an already-cleared payment is refused (the cap is held by the guard too)', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [sent.allocation]);
    const other = await plantBill(pool, conn);
    const moved = await reapply(pool, sent.payment, other.bill, 400);
    const exact = await manualContra(other.invoice, 400, `IC:${moved.message}`);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await acceptDirect(q, moved.message, exact)).toMatch(REFUSED); });
  });

  it('the exact clearing tampered with afterwards is refused: another total, another contra account, a second allocation line, more journal lines', async () => {
    const tamper: Array<[string, (payment: string, invoice: string) => Promise<unknown>]> = [
      ['total', (p) => pool.query('UPDATE customer_payments SET total_amount = 401 WHERE id = $1', [p])],
      ['contra account', (p) => pool.query('UPDATE customer_payments SET bank_account_id = $2 WHERE id = $1', [p, loan.a2])],
      ['second allocation line', async (p) => pool.query('INSERT INTO customer_payment_allocations(payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 0.01)', [p, (await plantBill(pool, conn)).invoice])],
      ['two more journal lines', (p) => withLinesUnfrozen(async (q) => {
        const je = (await q.query('SELECT gl_journal_entry_id AS je FROM customer_payments WHERE id = $1', [p])).rows[0].je as string;
        for (const [debit, credit] of [[0.01, 0], [0, 0.01]]) {
          await q.query("INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description) VALUES ($1, $2, $3, $4, $5, 'tampered')", [je, acct.aLoan, debit, credit, co.A]);
        }
      })],
    ];
    for (const [what, change] of tamper) {
      const sent = await sentClearable(pool, conn, { amount: 400 });
      const exact = await manualContra(sent.invoice, 400, `IC:${sent.message}`);
      await change(exact, sent.invoice);
      await asAppUser(pool, U.a, co.A, async (q) => { expect([what, await acceptDirect(q, sent.message, exact)]).toEqual([what, expect.stringMatching(REFUSED)]); });
    }
  });

  it('a target is never set on another transition (failed, dismissed)', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const exact = await manualContra(sent.invoice, 400, `IC:${sent.message}`);
    await asAppUser(pool, U.a, co.A, async (q) => {
      for (const status of ['failed', 'dismissed']) {
        expect(await outcome(q, "UPDATE intercompany_messages SET status = $2, target_doc_type = 'customer_payment', target_doc_id = $3 WHERE id = $1", [sent.message, status, exact]))
          .toMatch(/^23514: an allocation message names its clearing only when it is accepted/);
      }
    });
  });
});

describe('migration 1027 objects', () => {
  it('the liveness definer is owned by migration_admin, registered with its new hash, four columns; PUBLIC executes none of the three; the reach check is clean', async () => {
    const r = (await pool.query(`
      SELECT pg_get_userbyid(p.proowner) AS owner, pg_get_function_result(p.oid) AS result,
             (SELECT count(*)::int FROM app_definer_reviews r WHERE r.signature = 'intercompany_allocation_message_live(uuid)' AND r.body_md5 = app_definer_hash(p.oid)) AS reviewed
        FROM pg_proc p WHERE p.oid = 'public.intercompany_allocation_message_live(uuid)'::regprocedure`)).rows[0];
    expect(r).toEqual({ owner: 'migration_admin', result: 'TABLE(live boolean, reason text, cap text, payer_loan_type text)', reviewed: 1 });
    for (const fn of ['intercompany_allocation_message_live(uuid)', 'intercompany_allocation_cap_lock(uuid)', 'intercompany_is_loan_class(text, text, boolean)', 'intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid)']) {
      const g = (await pool.query("SELECT has_function_privilege('public', $1, 'EXECUTE') AS pub, has_function_privilege('app_user', $1, 'EXECUTE') AS app", [`public.${fn}`])).rows[0];
      expect([fn, g]).toEqual([fn, { pub: false, app: true }]);
    }
    const helpers = (await pool.query("SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('intercompany_allocation_cleared', 'intercompany_allocation_cap_lock', 'intercompany_is_loan_class', 'intercompany_allocation_target_ok') ORDER BY proname")).rows;
    expect(helpers).toEqual([{ proname: 'intercompany_allocation_cap_lock', prosecdef: false }, { proname: 'intercompany_allocation_target_ok', prosecdef: false }, { proname: 'intercompany_is_loan_class', prosecdef: false }]);
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });
});
