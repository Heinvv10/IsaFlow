/**
 * Intercompany P4-B isolation and forgery: the allocation definer reads only the session company's own rows and writes only its own message;
 * the messages guard refuses a session's own INSERT of an allocation message and a definer's naming a row that is not the sender's; the
 * definer is registered, owned by migration_admin and executable by app_user alone; the receiver's inbox and the auto-accept queue never see
 * an allocation message.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { asAppUser, asDefiner, outcome, plantAllocationRow, plantDocument, R } from './intercompany.helpers';
import { co, dataOf, inbox, mirrorCleanup, U, wipeConnections } from './mirror.helpers';
import {
  allocSetup, allocationMessages, clearPayments, linkBill, loanConnect, plantBill, plantPaid, plantPaymentJournal, sendFor,
} from './allocation.helpers';

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

const INSERT = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`;
const BY_DB = /^42501: a document message is written by the database/;

describe('another company\'s rows are not found', () => {
  it('the payer naming the issuer\'s (or a third company\'s) allocation row, as a user of both too, is not_found and writes nothing', async () => {
    const issuers = await plantAllocationRow(pool, { paymentCompany: co.A });
    const thirds = await plantAllocationRow(pool, { paymentCompany: co.C });
    for (const row of [issuers, thirds]) {
      expect(await sendFor(pool, row.allocation)).toEqual({ message_id: null, reason: 'not_found', detail: null });
      expect(await sendFor(pool, row.allocation, U.ab)).toEqual({ message_id: null, reason: 'not_found', detail: null });   // owner of A and B, acting as B
    }
    expect(await allocationMessages(pool)).toHaveLength(0);
  });

  it('a payment of ANOTHER company against the payer\'s linked bill is not_found, as is the payer\'s payment against ANOTHER company\'s bill', async () => {
    const { bill } = await plantBill(pool, conn);
    const journal = await plantPaymentJournal(pool, 1150);
    const foreignPayment = await plantAllocationRow(pool, { paymentCompany: co.C, bill, journal });     // the payer's journal, so only the company stops it
    expect((await sendFor(pool, foreignPayment.allocation)).reason).toBe('not_found');
    const foreign = await plantBill(pool, conn, { link: false });
    const foreignBill = await plantDocument(pool, 'supplier_invoice', co.C);
    await linkBill(pool, conn, foreign.invoice, foreignBill);                                              // a link naming it in the payer's slot (guard off)
    const mixed = await plantAllocationRow(pool, { paymentCompany: co.B, bill: foreignBill, journal: await plantPaymentJournal(pool, 1150) });
    expect((await sendFor(pool, mixed.allocation)).reason).toBe('not_found');
    expect(await allocationMessages(pool)).toHaveLength(0);
  });

  it('only the two parties read the message: the issuer sees it, a third company sees nothing', async () => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    await sendFor(pool, allocation);
    const seen = (user: string, company: string) => asAppUser(pool, user, company, async (q) =>
      Number((await q.query("SELECT count(*) AS n FROM intercompany_messages WHERE kind = 'allocation'")).rows[0].n));
    expect(await seen(U.b, co.B)).toBe(1);
    expect(await seen(U.a, co.A)).toBe(1);
    expect(await seen(U.c, co.C)).toBe(0);
    expect(await seen(U.ac, co.C)).toBe(0);
  });
});

describe('a session cannot write an allocation message, and a definer cannot name a row that is not the sender\'s', () => {
  it('app_user: the kind alone and the source type alone are refused (42501); a payment message naming a payment is still open', async () => {
    const own = (await plantPaid(pool, (await plantBill(pool, conn)).bill)).allocation;
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, INSERT, [conn, co.B, co.A, 'allocation', 'payment_allocation', own])).toMatch(BY_DB);
      expect(await outcome(q, INSERT, [conn, co.B, co.A, 'allocation', 'payment', own])).toMatch(BY_DB);             // the kind
      expect(await outcome(q, INSERT, [conn, co.B, co.A, 'payment', 'payment_allocation', own])).toMatch(BY_DB);     // the source type
      expect(await outcome(q, INSERT, [conn, co.B, co.A, 'payment', 'payment', crypto.randomUUID()])).toBe('ok');
    });
    expect(await allocationMessages(pool)).toHaveLength(0);
  });

  it('the definer\'s owner: a made-up row, another company\'s row, the wrong type and a payment of another company are refused (23514); the payer\'s own row is accepted', async () => {
    const own = (await plantPaid(pool, (await plantBill(pool, conn)).bill)).allocation;
    const issuers = (await plantAllocationRow(pool, { paymentCompany: co.A })).allocation;
    const thirds = (await plantAllocationRow(pool, { paymentCompany: co.C })).allocation;
    const send = (type: string, doc: string, user = U.b) => asDefiner(pool, user, co.B, (q) => outcome(q, INSERT, [conn, co.B, co.A, 'allocation', type, doc]));
    expect(await send('payment_allocation', crypto.randomUUID())).toBe(R.msgSource);
    expect(await send('payment_allocation', issuers)).toBe(R.msgSource);
    expect(await send('payment_allocation', thirds)).toBe(R.msgSource);
    expect(await send('payment_allocation', issuers, U.ab)).toBe(R.msgSource);              // sees both companies' rows, still refused
    expect(await send('payment', own)).toBe(R.msgSource);
    expect(await send('supplier_invoice', own)).toBe(R.msgSource);
    expect(await send('payment_allocation', own)).toBe('ok');
  });
});

describe('the definer is registered, owned by the definers\' owner and callable by app_user alone', () => {
  const SIG = 'public.intercompany_send_for_allocation(uuid)';
  it('SECURITY DEFINER, migration_admin, search_path pinned with pg_temp last, a current 930 registry row; PUBLIC cannot execute it, its ACL is the owner and app_user', async () => {
    const p = (await pool.query(
      `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig, p.provolatile,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              p.proacl::text AS acl,
              (SELECT count(*)::int FROM app_definer_reviews r WHERE r.signature = 'intercompany_send_for_allocation(uuid)' AND r.body_md5 = app_definer_hash(p.oid)) AS reviewed
         FROM pg_proc p WHERE p.oid = $1::regprocedure`, [SIG])).rows[0];
    expect(p).toMatchObject({ prosecdef: true, owner: 'migration_admin', pub: false, app: true, reviewed: 1, provolatile: 'v' });
    expect(p.acl).toBe('{migration_admin=X/migration_admin,app_user=X/migration_admin}');            // the owner and app_user, nobody else directly
    expect(p.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });

  it('the registry row describes what the definer writes, and its hash is the definer\'s current body', async () => {
    const r = (await pool.query("SELECT writes, body_md5 FROM app_definer_reviews WHERE signature = 'intercompany_send_for_allocation(uuid)'")).rows[0];
    expect(r.writes).toMatch(/intercompany_messages/);
    expect(r.body_md5).toBe((await pool.query('SELECT app_definer_hash($1::regprocedure) AS h', [SIG])).rows[0].h);
  });
});

describe('the receiver never sees an allocation message', () => {
  it('the issuer\'s inbox count and list, and the auto-accept queue (the issuer\'s side asks for it), pass over it', async () => {
    await asAppUser(pool, U.a, co.A, (q) => q.query("UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1 AND company_id = $2", [conn, co.A]), true);
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    expect((await sendFor(pool, allocation)).message_id).toBeTruthy();
    expect(dataOf<{ openCount: number }>(await inbox.count(U.a, co.A)).openCount).toBe(0);
    const list = dataOf<{ items?: unknown[] } | unknown[]>(await inbox.list(U.a, co.A));
    expect(Array.isArray(list) ? list : list.items).toHaveLength(0);
    expect(await runAutoAccept()).toMatchObject({ considered: 0 });
    expect((await allocationMessages(pool, allocation))[0].status).toBe('pending');
  });
});
