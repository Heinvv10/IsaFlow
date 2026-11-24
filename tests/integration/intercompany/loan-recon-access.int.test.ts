/**
 * Intercompany P5: who may read the report, and what it never answers ((c), (j).1, (j).2, (k).5). C naming the S-X connection, a random
 * uuid and a cash connection get the SAME 404 body, and b3 / b4 called straight answer zero rows; a user of both S and X in session S sees
 * S's perspective only; a viewer (no intercompany write role) is 403 and the definers answer zero rows; S's flag off is a 403 before any read
 * (the definers are replaced by ones that throw: still a 403) and the definers answer zero rows; a Login-as session and a session without a
 * session id are 403; an `asOf` parameter is a 400; only GET; b3's output columns are exactly the allowed list; more than 5 000 messages is
 * refused 422. The connection list names S's loan connections and those carrying an allocation message only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { impersonationToken } from '../r035-pr2.helpers';
import { callRoute } from '../r035-approval.helpers';
import reconRoute from '../../../pages/api/accounting/intercompany/loan-reconciliation/[connectionId]';
import { co, pairOf, tokens, U, wipeConnections, withoutTrigger } from './intercompany.helpers';
import { dataOf, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { sessionlessToken } from './allocation-clear-round1.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import {
  accepted, asPerson, ePay, errorOf, errorText, fixturePaid, instrument, listAs, opening, rawMessages, rawSummary, reconConnect, reconSetup, reportAs,
  reportOf,
} from './loan-recon.helpers';
import { loadReconRows } from '../../../src/modules/accounting/services/intercompany/loanReconService';
import type { ReconConnection } from '../../../src/modules/accounting/services/intercompany/loanReconTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => reconSetup(pool), 90000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  await clearPayments(pool);
  await wipeConnections(pool);
  await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2', [co.G, co.C]);
  conn = await reconConnect(pool);
  await opening(pool, 500, 500);
  await accepted(await ePay(pool, conn, 300));
});

const NOT_FOUND = async (user: string, company: string, id: string) => {
  const res = await reportAs(user, company, id);
  expect(res.state.statusCode, errorText(res)).toBe(404);
  return errorOf(res);
};

describe('no existence oracle', () => {
  it("C naming the S-X connection, a random uuid and B's cash connection: the identical 404; b3 / b4 answer zero rows to C", async () => {
    // C joins the group and gets a CASH connection with B
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [co.G, co.C]);
    const [low, high] = pairOf(co.B, co.C);
    const cash = await withoutTrigger(pool, 'intercompany_connections', 'trg_intercompany_connections_guard', async (q) => (await q.query(
      `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id, invited_by, accepted_by, accepted_at, settlement_mode)
       VALUES ($1, $2, 'group', 'active', $1, $3, $3, now(), 'cash') RETURNING id`, [low, high, U.ab])).rows[0].id as string);
    const bodies = [
      await NOT_FOUND(U.c, co.C, conn), await NOT_FOUND(U.b, co.B, crypto.randomUUID()), await NOT_FOUND(U.b, co.B, cash), await NOT_FOUND(U.ac, co.C, conn),
    ];
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(await rawMessages(pool, U.c, co.C, conn)).toEqual([]);
    expect(await rawSummary(pool, U.c, co.C, conn)).toEqual([]);
    // the list names the loan connection only
    const list = dataOf<{ connections: ReconConnection[] }>(await listAs(U.b, co.B)).connections;
    expect(list.map((c) => c.id)).toEqual([conn]);
    expect(list[0]).toMatchObject({ settlementMode: 'loan', status: 'active' });
    // the partner's name as the connections page shows it: only a member of the partner reads the partner's company row (RLS)
    expect(list[0]!.partnerName).toBe('Another company');
    expect(dataOf<{ connections: ReconConnection[] }>(await listAs(U.ab, co.B)).connections[0]!.partnerName).toMatch(/IC A/);
    expect(dataOf<{ connections: ReconConnection[] }>(await listAs(U.c, co.C)).connections).toEqual([]);
  });

  it('a cash connection carrying an allocation message is listed and reported', async () => {
    await fixturePaid(pool, conn, 120, { leg: undefined });
    await withoutTrigger(pool, 'intercompany_connections', 'trg_intercompany_connections_guard', (q) => q.query("UPDATE intercompany_connections SET settlement_mode = 'cash' WHERE id = $1", [conn]));
    expect(dataOf<{ connections: ReconConnection[] }>(await listAs(U.b, co.B)).connections.map((c) => c.id)).toEqual([conn]);
    expect((await reportAs(U.b, co.B, conn)).state.statusCode).toBe(200);
  });
});

describe('forged rows never reach the report', () => {
  it("a message on the connection between two OTHER companies is not S's; a payload naming a third company's invoice shows nothing of it", async () => {
    const m = await fixturePaid(pool, conn, 130, { leg: undefined });
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
       VALUES ($1, $2, $3, 'allocation', 'payment_allocation', gen_random_uuid(), '{"amount": 5}'::jsonb)`, [conn, co.C, co.A]));
    // B is no party to it; A is, but its sender is no company of the pair: neither session reads it (no fact of C is judged)
    expect(await rawMessages(pool, U.b, co.B, conn)).toHaveLength(2);
    expect(await rawMessages(pool, U.a, co.A, conn)).toHaveLength(2);
    // C's invoice, named by a forged payload of an out message (B's session) and of an in message (A's session)
    const cInvoice = crypto.randomUUID();
    const cCustomer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [cCustomer, co.C, 'C secret customer']);
    await pool.query(
      `INSERT INTO customer_invoices(id, company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount, currency_code, exchange_rate, status, created_by)
       VALUES ($1, $2, 'C-SECRET-1', $4, $4, DATE '2026-09-01', DATE '2026-10-01', 100, 0, 0, 100, 'ZAR', 1, 'approved', $3)`, [cInvoice, co.C, U.ab, cCustomer]);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET payload = jsonb_set(payload, '{issuerDocument,id}', to_jsonb($2::text)) WHERE id = $1", [m.message, cInvoice]));
    const out = (await rawMessages(pool, U.b, co.B, conn)).find((r) => r.message_id === m.message);
    expect(out?.partner_document).toBe('gone');
    const a = await reportAs(U.a, co.A, conn, { section: 'attention' });
    expect(JSON.stringify(a.state.body)).not.toContain('C-SECRET-1');
    expect(JSON.stringify(a.state.body)).not.toContain(cInvoice);
    const b = await reportAs(U.b, co.B, conn, { section: 'attention' });
    expect(JSON.stringify(b.state.body)).not.toContain('C-SECRET-1');
    // a member of A AND C in session A: RLS would let C's invoice through, the company_id = S lookup does not
    const ac = await reportAs(U.ac, co.A, conn, { section: 'attention' });
    expect(ac.state.statusCode).toBe(200);
    expect(JSON.stringify(ac.state.body)).not.toContain('C-SECRET-1');
    expect(reportOf(ac).section.items.find((i) => i.id === m.message)?.own.invoiceId).toBeNull();
  });
});

describe('the perspective is the session company only', () => {
  it('U.ab (a member of both) in session B sees B as S; in session A sees A as S', async () => {
    const asB = reportOf(await reportAs(U.ab, co.B, conn));
    const asA = reportOf(await reportAs(U.ab, co.A, conn));
    expect(asB.summary.own?.balance).toBe(-800);
    expect(asB.summary.partner?.balance).toBe(800);
    expect(asA.summary.own?.balance).toBe(800);
    expect(asA.summary.partner?.balance).toBe(-800);
  });
});

describe('who may read', () => {
  it('a viewer (no intercompany write role): 403 forbidden; b3 / b4 answer zero rows', async () => {
    const res = await reportAs(U.avb, co.B, conn);
    expect(res.state.statusCode).toBe(403);
    expect((await listAs(U.avb, co.B)).state.statusCode).toBe(403);
    expect(await rawMessages(pool, U.avb, co.B, conn)).toEqual([]);
    expect(await rawSummary(pool, U.avb, co.B, conn)).toEqual([]);
  });

  it("S's flag off: 403 not_enabled before any read (the definers throw if called), and b3 / b4 called straight answer zero rows", async () => {
    await setLoanClearing(pool, [co.B], false);
    try {
      for (const fn of ['intercompany_loan_recon_messages', 'intercompany_loan_recon_summary']) {
        await pool.query(`ALTER FUNCTION public.${fn}(uuid) RENAME TO ${fn}_p5_held`);
        await pool.query(`CREATE FUNCTION public.${fn}(p uuid) RETURNS SETOF record LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'p5: read before the flag'; END $$`);
        await pool.query(`GRANT EXECUTE ON FUNCTION public.${fn}(uuid) TO app_user`);
      }
      const res = await reportAs(U.b, co.B, conn);
      expect(res.state.statusCode, errorText(res)).toBe(403);
      expect(errorText(res)).toContain('Intercompany loan reconciliation is not enabled for this company.');
      expect((await listAs(U.b, co.B)).state.statusCode).toBe(403);
    } finally {
      for (const fn of ['intercompany_loan_recon_messages', 'intercompany_loan_recon_summary']) {
        await pool.query(`DROP FUNCTION IF EXISTS public.${fn}(uuid)`);
        await pool.query(`ALTER FUNCTION public.${fn}_p5_held(uuid) RENAME TO ${fn}`);
      }
    }
    expect(await rawMessages(pool, U.b, co.B, conn)).toEqual([]);
    expect(await rawSummary(pool, U.b, co.B, conn)).toEqual([]);
    await setLoanClearing(pool, [co.B], null);
    expect(await rawSummary(pool, U.b, co.B, conn)).toEqual([]);
  });

  it('a Login-as session and a session without a session id: 403, nothing read', async () => {
    const imp = await reportAs(U.b, co.B, conn, {}, await impersonationToken(pool, U.b, U.ab));
    expect(imp.state.statusCode).toBe(403);
    expect(errorText(imp)).toMatch(/IMPERSONATION_FORBIDDEN|impersonat/i);
    expect((await reportAs(U.b, co.B, conn, {}, await sessionlessToken(U.b))).state.statusCode).toBe(403);
  });

  it('no plan carries the flag: the database rule (override else is_global) is the authority ((k).5)', async () => {
    const n = (await pool.query(
      "SELECT count(*)::int AS n FROM plan_features pf JOIN feature_flags ff ON ff.id = pf.feature_id WHERE ff.code = 'intercompany_loan_clearing'")).rows[0].n;
    expect(n).toBe(0);
    expect((await pool.query("SELECT is_global FROM feature_flags WHERE code = 'intercompany_loan_clearing'")).rows[0].is_global).toBe(false);
  });
});

describe('the request', () => {
  it('an asOf parameter (any value) is a 400; a connection that is no UUID is a 400; only GET', async () => {
    for (const q of [{ asOf: '2026-01-01' }, { asOf: '' }]) expect((await reportAs(U.b, co.B, conn, q)).state.statusCode).toBe(400);
    expect((await reportAs(U.b, co.B, 'not-a-uuid')).state.statusCode).toBe(400);
    expect((await reportAs(U.b, co.B, conn, { section: 'everything' })).state.statusCode).toBe(400);
    const post = await callRoute(reconRoute, tokens[U.b]!, co.B, 'POST', {}, `/api/accounting/intercompany/loan-reconciliation/${conn}`, { connectionId: conn });
    expect(post.state.statusCode).toBe(405);
  });

  it("b3's output columns are exactly the allowed list (a census: a new column fails here)", async () => {
    const r = (await pool.query(
      "SELECT pg_get_function_result('public.intercompany_loan_recon_messages(uuid)'::regprocedure) AS r, pg_get_function_result('public.intercompany_loan_recon_summary(uuid)'::regprocedure) AS s")).rows[0];
    expect(r.r).toBe('TABLE(message_id uuid, direction text, payer_state text, payer_after_t boolean, payer_loan_credit boolean, payer_counts boolean, '
      + 'payer_journal_differs boolean, receiver_state text, receiver_after_t boolean, receiver_counts boolean, loan_account_changed boolean, partner_document text)');
    expect(r.s).toBe('TABLE(partner_state text, as_of date, own_balance numeric, own_attributed numeric, own_other numeric, own_loan_shared boolean, '
      + 'partner_balance numeric, partner_other numeric)');
    const rows = await rawMessages(pool, U.b, co.B, conn);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).toHaveLength(12);
  });

  it('more than 5 000 allocation messages on the connection: 422, no partial answer', async () => {
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload, status, reason)
       SELECT $1, $2, $3, 'allocation', 'payment_allocation', gen_random_uuid(), '{"amount": 1}'::jsonb, 'rejected', 'p5 cap' FROM generate_series(1, 5000)`,
      [conn, co.B, co.A]));
    const res = await reportAs(U.b, co.B, conn);
    expect(res.state.statusCode, errorText(res)).toBe(422);
    expect(errorText(res)).toMatch(/too many to reconcile in one view/);
  }, 60000);

  it('the statement bound is 15 s, tighten-only, and the caller\'s value is put back after the read', async () => {
    const restore = await instrument(pool, 'public.intercompany_journal_chain_members(uuid, uuid)',
      "PERFORM pg_catalog.set_config('p5.seen_timeout', pg_catalog.current_setting('statement_timeout'), true);");
    try {
      for (const [caller, during] of [['0', '15s'], ['30s', '15s'], ['5s', '5s']] as const) {
        const seen = await asPerson(pool, U.b, co.B, async (q) => {
          await q.query(`SET LOCAL statement_timeout = '${caller}'`);
          await loadReconRows(co.B, conn);
          return (await q.query("SELECT current_setting('p5.seen_timeout', true) AS d, current_setting('statement_timeout') AS after")).rows[0];
        });
        expect(seen, caller).toEqual({ d: during, after: caller === '0' ? '0' : caller });
      }
    } finally {
      await restore();
    }
  });
});
