/**
 * Intercompany P5: the report writes nothing and blocks nothing ((j).11), reads one snapshot ((f), (j).4), and its functions are what the
 * plan says ((b), (k).10, (l).8). Read only: row counts, the messages' updated_at, journal counts unchanged; no transaction id assigned, no
 * advisory lock and no lock stronger than AccessShare held; a concurrent FOR UPDATE NOWAIT on the message and on the companies' rows does not
 * wait. Snapshot: a split read (summary, then an accept commits, then the messages) disagrees with itself; the real single statement, with the
 * accept committed WHILE it runs, does not. Registry: b3 / b4 registered with their hash, owned by migration_admin, search_path pinned;
 * PUBLIC executes none of b0-b4, app_user none of b0-b2; b0-b4 and every callee STABLE. Consistency: b1 against intercompany_journal_chain_eff
 * for every journal; b2 against intercompany_allocation_payer_standing for every message (the cases it does not judge pinned by name); each
 * chain walked once (a call counter on intercompany_journal_chain_eff).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { loadReconRows } from '../../../src/modules/accounting/services/intercompany/loanReconService';
import { acct, co, U, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import {
  accepted, asPerson, cancelReceipt, dayOf, ePay, fixturePaid, instrument, opening, payable, plantJournal, preGateVoid, rawMessages, rawSummary,
  reconConnect, reconSetup, reportAs, reportOf, reverseOn,
} from './loan-recon.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let conn = '';

beforeAll(() => reconSetup(pool), 90000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await reconConnect(pool);
});

const B5 = ['intercompany_loan_recon_partner_state(uuid,uuid)', 'intercompany_journal_chain_members(uuid,uuid)',
  'intercompany_allocation_payer_state(uuid,date,date[])', 'intercompany_loan_recon_messages(uuid)', 'intercompany_loan_recon_summary(uuid)'];
const CALLEES = ['app.current_company_id()', 'auth.uid()', 'auth.user_companies()', 'public.intercompany_user_can_write(uuid)',
  'public.intercompany_shared_group(uuid,uuid)', 'public.intercompany_journal_chain_eff(uuid,uuid)', 'public.intercompany_journal_chain_length(uuid,uuid,date,date[])',
  'public.intercompany_lines_negate(uuid,uuid)', 'public.intercompany_pair_cutovers(uuid)', 'public.rls_user_group_ids()'];

describe('read only', () => {
  it('nothing moves around a report; no xid, no advisory lock, nothing above AccessShare; a concurrent FOR UPDATE NOWAIT does not wait', async () => {
    await opening(pool, 100, 100);
    const m = await ePay(pool, conn, 200);
    await accepted(m);
    const tables = ['intercompany_messages', 'gl_journal_entries', 'gl_journal_lines', 'customer_payments', 'supplier_payments', 'payment_allocations',
      'audit_log', 'company_feature_overrides', 'intercompany_connection_sides', 'intercompany_connections'];
    const census = async () => [
      ...(await Promise.all(tables.map(async (t) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)))),
      String((await pool.query('SELECT max(updated_at)::text AS u FROM intercompany_messages')).rows[0].u),
    ];
    const before = await census();
    const held = await asPerson(pool, U.b, co.B, async (q) => {
      await loadReconRows(co.B, conn);
      const xid = (await q.query('SELECT txid_current_if_assigned() AS x')).rows[0].x;
      const locks = (await q.query('SELECT locktype, mode FROM pg_locks WHERE pid = pg_backend_pid()')).rows as { locktype: string; mode: string }[];
      // another session takes the rows a report could have held, without waiting
      const other = await pool.connect();
      try {
        await other.query('BEGIN');
        await other.query('SELECT id FROM intercompany_messages WHERE id = $1 FOR UPDATE NOWAIT', [m.message]);
        await other.query('SELECT id FROM companies WHERE id = ANY($1) FOR UPDATE NOWAIT', [[co.A, co.B]]);
        await other.query('SELECT id FROM intercompany_connections WHERE id = $1 FOR UPDATE NOWAIT', [conn]);
        await other.query('ROLLBACK');
      } finally {
        other.release();
      }
      return { xid, locks };
    });
    expect(held.xid).toBeNull();
    expect(held.locks.filter((l) => l.locktype === 'advisory')).toEqual([]);
    expect(held.locks.filter((l) => l.locktype === 'relation' && l.mode !== 'AccessShareLock')).toEqual([]);
    expect(held.locks.filter((l) => l.locktype === 'transactionid' || l.locktype === 'tuple')).toEqual([]);
    expect(await census()).toEqual(before);
  });
});

describe('one snapshot ((f), (j).4)', () => {
  it('a split read disagrees with itself; the one statement with an accept committed while it runs does not', async () => {
    const m = await ePay(pool, conn, 900);
    // split: the summary, then the accept commits, then the messages
    const split = await asPerson(pool, U.b, co.B, async (q) => {
      const s = (await q.query('SELECT * FROM public.intercompany_loan_recon_summary($1)', [conn])).rows[0];
      await accepted(m);
      const rows = (await q.query('SELECT * FROM public.intercompany_loan_recon_messages($1)', [conn])).rows;
      return { s, rows };
    });
    expect(Number(split.s.partner_balance)).toBe(0);
    expect(split.rows[0]).toMatchObject({ receiver_counts: true });
    // the real read: a callee sleeps once inside the statement while another accept commits
    const n = await ePay(pool, conn, 300);
    const restore = await instrument(pool, 'public.intercompany_journal_chain_members(uuid, uuid)',
      "IF pg_catalog.current_setting('p5.slept', true) IS DISTINCT FROM '1' THEN PERFORM pg_catalog.set_config('p5.slept', '1', true); PERFORM pg_catalog.pg_sleep(2); END IF;");
    try {
      const reading = reportAs(U.b, co.B, conn);
      for (let i = 0; i < 100; i += 1) {
        const w = (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE '%intercompany_loan_recon_summary%'")).rows[0].n;
        if (w > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await accepted(n);
      const r = reportOf(await reading);
      expect(r.summary.identityFailures).toBe(0);
      expect(r.summary.unexplained?.total).toBe(0);
      // as of the statement's start: n was not yet accepted, and the partner's figure does not hold its receipt
      expect(r.summary.partner?.balance).toBe(900);
      expect(r.summary.components?.find((c) => c.key === 'in_flight')).toEqual({ key: 'in_flight', amount: -300, count: 1 });
    } finally {
      await restore();
    }
    const after = reportOf(await reportAs(U.b, co.B, conn));
    expect(after.summary.partner?.balance).toBe(1200);
    expect(after.summary.unexplained?.total).toBe(0);
  }, 30000);
});

describe('registry, grants, volatility ((b5), (k).10)', () => {
  it('b3 / b4 registered with their hash, owned by migration_admin, search_path pinned; app_pool_reach passes', async () => {
    for (const sig of ['intercompany_loan_recon_messages(uuid)', 'intercompany_loan_recon_summary(uuid)']) {
      const r = (await pool.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                (SELECT count(*)::int FROM app_definer_reviews d WHERE d.signature = $1 AND d.body_md5 = app_definer_hash(p.oid)) AS reviewed,
                (SELECT d.writes FROM app_definer_reviews d WHERE d.signature = $1) AS writes
           FROM pg_proc p WHERE p.oid = ('public.' || $1)::regprocedure`, [sig])).rows[0];
      expect(r, sig).toMatchObject({ prosecdef: true, owner: 'migration_admin', reviewed: 1 });
      expect(r.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(String(r.writes)).toMatch(/^nothing \(STABLE, no lock\)/);
    }
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });

  it('PUBLIC executes none of b0-b4; app_user only b3 / b4; migration_admin all; b0-b2 are INVOKER', async () => {
    for (const sig of B5) {
      const r = (await pool.query(
        `SELECT has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub, has_function_privilege('app_user', $1::regprocedure, 'EXECUTE') AS app,
                has_function_privilege('migration_admin', $1::regprocedure, 'EXECUTE') AS adm, (SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure) AS def`,
        [`public.${sig}`])).rows[0];
      const definer = sig.startsWith('intercompany_loan_recon_messages') || sig.startsWith('intercompany_loan_recon_summary');
      expect(r, sig).toEqual({ pub: false, app: definer, adm: true, def: definer });
    }
  });

  it('b0-b4 and every callee are STABLE; the bodies call no VOLATILE function and take no lock', async () => {
    for (const sig of [...B5.map((s) => `public.${s}`), ...CALLEES]) {
      const v = (await pool.query('SELECT provolatile FROM pg_proc WHERE oid = $1::regprocedure', [sig])).rows[0]?.provolatile;
      expect(v, sig).toBe('s');
    }
    const bodies = (await pool.query('SELECT proname, prosrc FROM pg_proc WHERE oid = ANY($1::regprocedure[])', [B5.map((s) => `public.${s}`)])).rows as { proname: string; prosrc: string }[];
    for (const b of bodies) {
      expect(b.prosrc, b.proname).not.toMatch(/FOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b|pg_advisory|intercompany_in_one_group|intercompany_lock_companies|lock_timeout/i);
      // every schema-qualified callee in a body is STABLE or IMMUTABLE
      for (const [, schema, fn] of b.prosrc.matchAll(/\b(public|app|auth)\.([a-z_0-9]+)\s*\(/g)) {
        const vols = (await pool.query(
          'SELECT DISTINCT p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2', [schema, fn])).rows
          .map((r) => r.provolatile as string);
        if (vols.length === 0) continue; // a table or a column, not a function
        expect(vols.filter((x) => x === 'v'), `${b.proname} calls ${schema}.${fn}`).toEqual([]);
      }
    }
  });
});

describe('the STABLE halt ((b5), (k).10)', () => {
  it('the migration refuses to finish when b0-b4 or a callee is not STABLE', async () => {
    const MIGRATION = readFileSync(path.resolve(__dirname, '../../../scripts/migrations/sql/1030_intercompany_p5_loan_reconciliation.sql'), 'utf8');
    const b4 = 'CREATE OR REPLACE FUNCTION public.intercompany_loan_recon_summary(p_connection uuid)';
    const at = MIGRATION.indexOf(b4);
    const volatileB4 = MIGRATION.slice(0, at) + MIGRATION.slice(at).replace('LANGUAGE plpgsql\nSTABLE', 'LANGUAGE plpgsql\nVOLATILE');
    expect(volatileB4).not.toBe(MIGRATION);
    const cases: [string, string[]][] = [
      // a callee made VOLATILE elsewhere: the migration's halts refuse
      ['a callee', ['ALTER FUNCTION public.intercompany_lines_negate(uuid, uuid) VOLATILE', MIGRATION]],
      // b4 itself written VOLATILE: the whole migration, as the deploy applies it, refuses
      ['b4', [volatileB4]],
    ];
    for (const [name, statements] of cases) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [i, text] of statements.entries()) {
          if (i < statements.length - 1) await client.query(text);
          else await expect(client.query(text), name).rejects.toThrow(/is not STABLE/);
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    expect((await pool.query("SELECT provolatile FROM pg_proc WHERE oid = 'public.intercompany_loan_recon_summary(uuid)'::regprocedure")).rows[0].provolatile).toBe('s');
  });
});

describe('consistency ((b1), (b2))', () => {
  /** A ledger with every chain shape: one journal, reversed, reversed and reversed again, a forged non-negating link, future-dated. */
  async function shapes() {
    const standing = await fixturePaid(pool, conn, 110, { leg: acct.bLoan });
    const voided = await ePay(pool, conn, 120);
    await preGateVoid(pool, voided);
    const twice = await fixturePaid(pool, conn, 130, { leg: acct.bLoan });
    await reverseOn(pool, await reverseOn(pool, twice.journal, '2026-09-21'), '2026-09-22');
    const forged = await fixturePaid(pool, conn, 140, { leg: acct.bLoan });
    const fake = await plantJournal(pool, co.B, '2026-09-23', [[payable.b, 1, 0], [acct.bLoan, 0, 1]], 'P5 forged reversal');
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [fake, forged.journal]);
    const reversedOnly = await fixturePaid(pool, conn, 150, { leg: acct.bLoan });
    await reverseOn(pool, reversedOnly.journal, '2026-09-24');
    const gone = await fixturePaid(pool, conn, 160, { leg: acct.bLoan });
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [gone.allocation]);
    const changed = await fixturePaid(pool, conn, 170, { leg: acct.bLoan });
    await pool.query('UPDATE payment_allocations SET amount_allocated = 169 WHERE id = $1', [changed.allocation]);
    const billGone = await fixturePaid(pool, conn, 180, { leg: acct.bLoan });
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [billGone.bill]);
    const futureJe = await plantJournal(pool, co.B, await dayOf(pool, 2), [[payable.b, 190, 0], [acct.bLoan, 0, 190]]);
    const future = await fixturePaid(pool, conn, 190, { journal: futureJe });
    const futureRev = await fixturePaid(pool, conn, 200, { leg: acct.bLoan });
    await reverseOn(pool, futureRev.journal, await dayOf(pool, 2));
    const acc = await ePay(pool, conn, 210);
    await cancelReceipt(pool, (await accepted(acc)).receipt);
    return { standing, voided, twice, forged, reversedOnly, gone, changed, billGone, future, futureRev, acc };
  }

  it('b1: for every journal of both companies, cardinality(chain_eff) = count(chain_members); a forged link is no member', async () => {
    const s = await shapes();
    const r = (await pool.query(
      `SELECT je.id, cardinality(public.intercompany_journal_chain_eff(je.id, je.company_id)) AS eff,
              (SELECT count(*)::int FROM public.intercompany_journal_chain_members(je.id, je.company_id)) AS members
         FROM gl_journal_entries je WHERE je.company_id = ANY($1)`, [[co.A, co.B]])).rows as { id: string; eff: number; members: number }[];
    expect(r.length).toBeGreaterThan(20);
    for (const x of r) expect(x.members, x.id).toBe(x.eff);
    const members = async (je: string) => (await pool.query('SELECT id FROM public.intercompany_journal_chain_members($1, $2)', [je, co.B])).rows.map((x) => x.id);
    expect(await members(s.twice.journal)).toHaveLength(3);
    expect(await members(s.forged.journal)).toEqual([s.forged.journal]);
    expect(await members(s.voided.journal)).toHaveLength(2);
  });

  it("b2 at T agrees with intercompany_allocation_payer_standing for every message, except the cases it does not judge (pinned by name)", async () => {
    const s = await shapes();
    const rows = (await pool.query(
      `SELECT m.id, public.intercompany_allocation_payer_state(m.id, (statement_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date,
                public.intercompany_journal_chain_eff(m.source_journal_entry_id, m.from_company_id)) AS state,
              public.intercompany_allocation_payer_standing(m.id) AS standing
         FROM intercompany_messages m WHERE m.connection_id = $1 AND m.kind = 'allocation'`, [conn])).rows as { id: string; state: string; standing: boolean }[];
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[s.standing.message]).toMatchObject({ state: 'standing', standing: true });
    expect(by[s.voided.message]).toMatchObject({ state: 'payment_not_posted', standing: false });
    expect(by[s.twice.message]).toMatchObject({ state: 'standing', standing: true });
    expect(by[s.forged.message]).toMatchObject({ state: 'standing', standing: true });
    expect(by[s.reversedOnly.message]).toMatchObject({ state: 'journal_reversed', standing: false });
    expect(by[s.gone.message]).toMatchObject({ state: 'allocation_gone', standing: false });
    expect(by[s.acc.message]).toMatchObject({ state: 'standing', standing: true });
    // not judged by payer_standing: changed, bill_gone (it says standing); the future-dated chains (it judges them now)
    expect(by[s.changed.message]).toMatchObject({ state: 'changed', standing: true });
    expect(by[s.billGone.message]).toMatchObject({ state: 'bill_gone', standing: true });
    expect(by[s.future.message]).toMatchObject({ state: 'dated_after', standing: true });
    expect(by[s.futureRev.message]).toMatchObject({ state: 'standing', standing: false });
    const pinned = new Set([s.changed, s.billGone, s.future, s.futureRev].map((x) => x.message));
    for (const r of rows.filter((x) => !pinned.has(x.id))) expect(r.state === 'standing', r.id).toBe(r.standing);
  });

  it('each chain is walked once: intercompany_journal_chain_eff is called once per distinct payer journal and receipt, not per message', async () => {
    await shapes();
    const restore = await instrument(pool, 'public.intercompany_journal_chain_eff(uuid, uuid)',
      "PERFORM pg_catalog.set_config('p5.walks', (COALESCE(NULLIF(pg_catalog.current_setting('p5.walks', true), ''), '0')::int + 1)::text, true);");
    try {
      const walks = await asPerson(pool, U.b, co.B, async (q) => {
        await q.query('SELECT * FROM public.intercompany_loan_recon_messages($1)', [conn]);
        return Number((await q.query("SELECT current_setting('p5.walks', true) AS n")).rows[0].n);
      });
      const chains = (await pool.query(
        `SELECT count(DISTINCT source_journal_entry_id)::int + count(DISTINCT target_doc_id) FILTER (WHERE status = 'accepted')::int AS n
           FROM intercompany_messages WHERE connection_id = $1 AND kind = 'allocation'`, [conn])).rows[0].n as number;
      expect(walks).toBe(chains);
    } finally {
      await restore();
    }
    expect((await rawMessages(pool, U.b, co.B, conn)).length).toBe(11);
    expect((await rawSummary(pool, U.b, co.B, conn))[0]?.partner_state).toBe('ok');
  });
});
