/**
 * Intercompany F (migration 1031): the GAP closed and the authority for "one message per payer allocation row". app_user can no longer INSERT a
 * `kind = 'payment'` message (any source_doc_type): only the definer's owner (migration_admin) writes one, and only naming a payment allocation
 * of the sender's own payment. IX1 refuses a second message of the other kind for the same allocation row even from migration_admin. The four
 * definers are registered with their hash; PUBLIC executes none of them; app_user cannot execute H1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { R, asAppUser, asDefiner, count, outcome, plantAllocationRow, plantMessage, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { cashConnect, clearReceipts, co, paymentMessages, paymentSetup, sentPayment, U } from './payment.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => paymentSetup(pool), 60000);
afterAll(async () => { await clearReceipts(pool); await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearReceipts(pool);
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await cashConnect(pool);
});

const INSERT = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                VALUES ($1, $2, $3, $4, $5, $6, '{}')`;
const BY_DB = /^42501: a document message is written by the database/;

describe('the gap: app_user cannot write a payment message', () => {
  it.each([['payment'], ['payment_allocation'], ['customer_invoice'], ['bank_line']])('refused 42501 with source_doc_type %s', async (type) => {
    const own = (await plantAllocationRow(pool, { paymentCompany: co.B })).allocation;
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, INSERT, [conn, co.B, co.A, 'payment', type, own])).toMatch(BY_DB);
    });
    expect(await paymentMessages(pool)).toHaveLength(0);
  });

  it('reject and credit_request stay open to app_user (the probes the suites use)', async () => {
    await asAppUser(pool, U.b, co.B, async (q) => {
      for (const kind of ['reject', 'credit_request']) expect(await outcome(q, INSERT, [conn, co.B, co.A, kind, 'payment', crypto.randomUUID()]), kind).toBe('ok');
    });
  });

  it('migration_admin writes one only naming a payment allocation of the sender', async () => {
    const own = (await plantAllocationRow(pool, { paymentCompany: co.B })).allocation;
    const foreign = (await plantAllocationRow(pool, { paymentCompany: co.A })).allocation;
    await asDefiner(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, INSERT, [conn, co.B, co.A, 'payment', 'payment', own])).toBe(R.msgSource);
      expect(await outcome(q, INSERT, [conn, co.B, co.A, 'payment', 'payment_allocation', foreign])).toBe(R.msgSource);
      expect(await outcome(q, INSERT, [conn, co.B, co.A, 'payment', 'payment_allocation', own])).toBe('ok');
    });
  });

  it('plantMessage plants a real allocation row for kind payment', async () => {
    const id = await plantMessage(pool, conn, co.B, co.A, { kind: 'payment', user: U.b });
    const m = (await pool.query('SELECT source_doc_type, source_doc_id FROM intercompany_messages WHERE id = $1', [id])).rows[0];
    expect(m.source_doc_type).toBe('payment_allocation');
    expect(await count(pool, 'SELECT count(*) AS n FROM payment_allocations WHERE id = $1', [m.source_doc_id])).toBe(1);
  });
});

describe('IX1: one message of either kind per payer allocation row', () => {
  it('a migration_admin-forged allocation message for a row that already has a payment message is refused 23505', async () => {
    const s = await sentPayment(pool, conn);
    await asDefiner(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, INSERT, [conn, co.B, co.A, 'allocation', 'payment_allocation', s.allocation]))
        .toMatch(/^23505: duplicate key value violates unique constraint "intercompany_messages_one_payment_kind"/);
    });
    expect(await count(pool, "SELECT count(*) AS n FROM intercompany_messages WHERE source_doc_id = $1", [s.allocation])).toBe(1);
  });

  it('the index exists, partial on the two payment kinds', async () => {
    const def = String((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'intercompany_messages_one_payment_kind'")).rows[0]?.indexdef ?? '');
    expect(def).toMatch(/UNIQUE INDEX .* \(from_company_id, source_doc_id\) WHERE .*payment_allocation.*allocation.*payment/);
  });

  it('IX2: target_uq is narrowed to every kind but payment', async () => {
    const def = String((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'intercompany_messages_target_uq'")).rows[0]?.indexdef ?? '');
    expect(def).toMatch(/kind <> 'payment'/);
  });
});

describe('registry and grants', () => {
  const DEFINERS = ['intercompany_send_for_payment(uuid)', 'intercompany_payment_message_state(uuid)', 'intercompany_send_for_allocation(uuid)',
    'intercompany_discard_payment_draft(uuid,uuid,text)'];
  it.each(DEFINERS)('%s is registered with its current hash, owned by migration_admin', async (sig) => {
    const r = (await pool.query(
      `SELECT r.body_md5 = public.app_definer_hash(('public.' || r.signature)::regprocedure) AS ok, pg_get_userbyid(p.proowner) AS owner, p.prosecdef
         FROM app_definer_reviews r JOIN pg_proc p ON p.oid = ('public.' || r.signature)::regprocedure WHERE r.signature = $1`, [sig])).rows[0];
    expect(r).toMatchObject({ ok: true, owner: 'migration_admin', prosecdef: true });
  });

  it('PUBLIC executes none; app_user executes D1, D2, D4, H2, H3, H4 and not H1', async () => {
    const can = async (role: string, fn: string) => (await pool.query('SELECT has_function_privilege($1, $2, \'EXECUTE\') AS ok', [role, fn])).rows[0].ok as boolean;
    const fns = ['public.intercompany_send_for_payment(uuid)', 'public.intercompany_payment_message_state(uuid)', 'public.intercompany_discard_payment_draft(uuid, uuid, text)',
      'public.intercompany_payment_target_ok(uuid, jsonb, uuid, uuid, text, uuid)', 'public.intercompany_allocation_cap_lock(uuid)',
      'public.intercompany_payment_cash_word(uuid, uuid)'];
    for (const fn of [...fns, 'public.intercompany_payment_payer_standing(uuid)']) expect(await can('public', fn), fn).toBe(false);
    for (const fn of fns) expect(await can('app_user', fn), fn).toBe(true);
    expect(await can('app_user', 'public.intercompany_payment_payer_standing(uuid)')).toBe(false);
    expect(await can('migration_admin', 'public.intercompany_payment_payer_standing(uuid)')).toBe(true);
    expect(await can('migration_admin', 'public.intercompany_payment_cash_word(uuid, uuid)')).toBe(true);   // round 2: D1 (its owner) calls H4
  });

  it('app_pool_reach passes (no app pool reaches what it must not)', async () => {
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });

  it('the flag description names both kinds', async () => {
    const d = String((await pool.query("SELECT description FROM feature_flags WHERE code = 'intercompany_loan_clearing'")).rows[0].description);
    expect(d).toBe('Intercompany payment messages: loan-mode clearing (allocation messages) and cash-mode payment match suggestions (payment messages). Off by default.');
  });
});
