/**
 * Intercompany P4-C: who may ask whether an allocation message is live (`intercompany_allocation_message_live`, migration 1026). Only the
 * RECEIVER: a session of the message's `to_company_id`, a signed-in member. Everyone else (the payer naming its own message, a third company,
 * no session, a member of nothing, a non-allocation or made-up id) gets the same one row `(false, 'not_found')`: no existence oracle. The
 * definer is registered (930), owned by migration_admin and executable by app_user alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { plantMessage, withoutTrigger } from './intercompany.helpers';
import { co, mirrorCleanup, U, wipeConnections } from './mirror.helpers';
import { allocSetup, clearPayments, loanConnect } from './allocation.helpers';
import { liveFor, liveRows, liveWithoutUser, sentAllocation } from './allocation-live.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => allocSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await loanConnect(pool);
});

const NOT_FOUND = [{ live: false, reason: 'not_found' }];

describe('only the receiver is answered', () => {
  it('the payer naming its own message, a third company, and a user of both acting as the payer are not_found', async () => {
    const { message } = await sentAllocation(pool, conn);
    expect(await liveRows(pool, message, U.b, co.B)).toEqual(NOT_FOUND);           // the sender
    expect(await liveRows(pool, message, U.ab, co.B)).toEqual(NOT_FOUND);          // a member of both, in the payer's session
    expect(await liveRows(pool, message, U.c, co.C)).toEqual(NOT_FOUND);           // a third company
    expect(await liveRows(pool, message, U.vc, co.C)).toEqual(NOT_FOUND);
    expect(await liveRows(pool, message, U.ab, co.A)).toEqual([{ live: true, reason: 'ok' }]);
  });

  it('a session naming the receiver\'s company with a user who is no member of it is not_found (the GUC is any session\'s to set)', async () => {
    const { message } = await sentAllocation(pool, conn);
    expect(await liveRows(pool, message, U.x, co.A)).toEqual(NOT_FOUND);
    expect(await liveRows(pool, message, U.c, co.A)).toEqual(NOT_FOUND);
  });

  it('no session (no signed-in user, with or without a company) is not_found', async () => {
    const { message } = await sentAllocation(pool, conn);
    expect(await liveWithoutUser(pool, message, co.A)).toEqual(NOT_FOUND);
    expect(await liveWithoutUser(pool, message, null)).toEqual(NOT_FOUND);
  });

  it('a made-up id, a NULL id and a message of another kind addressed to the receiver are not_found, exactly as a foreign one', async () => {
    const payment = await plantMessage(pool, conn, co.B, co.A, { kind: 'payment', user: U.b });
    const invoice = await plantMessage(pool, conn, co.B, co.A, { kind: 'invoice', user: U.b });
    for (const id of [crypto.randomUUID(), payment, invoice]) expect(await liveRows(pool, id)).toEqual(NOT_FOUND);
    expect(await liveRows(pool, null as unknown as string)).toEqual(NOT_FOUND);
  });
});

describe('belt and braces: two pending messages naming the same payment and bill', () => {
  it('both answer duplicate while the allocation row stands (planted: the unique keys make it unreachable through the definers)', async () => {
    const sent = await sentAllocation(pool, conn);
    // a second message B -> A naming the same allocation row under ANOTHER from-company (the one way past the unique key), guard off
    const twin = await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', async (q) => (await q.query(
      `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload, source_journal_entry_id, status)
       SELECT connection_id, $2, to_company_id, kind, source_doc_type, source_doc_id, payload, source_journal_entry_id, 'pending'
         FROM intercompany_messages WHERE id = $1 RETURNING id`, [sent.message, co.C])).rows[0].id as string);
    expect(await liveFor(pool, sent.message)).toEqual({ live: false, reason: 'duplicate' });
    await pool.query('DELETE FROM intercompany_messages WHERE id = $1', [twin]);
    expect(await liveFor(pool, sent.message)).toEqual({ live: true, reason: 'ok' });
  });
});

describe('the definer is registered, owned by the definers\' owner and callable by app_user alone', () => {
  const SIG = 'public.intercompany_allocation_message_live(uuid)';
  it('SECURITY DEFINER, migration_admin, search_path pinned with pg_temp last, a current 930 registry row; PUBLIC cannot execute it', async () => {
    const p = (await pool.query(
      `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              p.proacl::text AS acl, pg_get_function_result(p.oid) AS result,
              (SELECT count(*)::int FROM app_definer_reviews r WHERE r.signature = 'intercompany_allocation_message_live(uuid)' AND r.body_md5 = app_definer_hash(p.oid)) AS reviewed
         FROM pg_proc p WHERE p.oid = $1::regprocedure`, [SIG])).rows[0];
    expect(p).toMatchObject({ prosecdef: true, owner: 'migration_admin', pub: false, app: true, reviewed: 1, result: 'TABLE(live boolean, reason text)' });
    // the owner and app_user, nobody else directly (a role that is a member of app_user reaches it as it reaches every app_user grant)
    expect(p.acl).toBe('{migration_admin=X/migration_admin,app_user=X/migration_admin}');
    expect(p.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });

  it('the registry row says it writes nothing, and its hash is the definer\'s current body', async () => {
    const r = (await pool.query("SELECT writes, body_md5 FROM app_definer_reviews WHERE signature = 'intercompany_allocation_message_live(uuid)'")).rows[0];
    expect(r.writes).toMatch(/^nothing/);
    expect(r.body_md5).toBe((await pool.query('SELECT app_definer_hash($1::regprocedure) AS h', [SIG])).rows[0].h);
  });
});
