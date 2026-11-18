/**
 * Migration 999r, round 2: who WRITES within a group a session belongs to, as app_user. Viewers of a member
 * company read and change nothing; a transaction is changed only by the writer of one of its parties and only in
 * its status; a mapping's accounts belong to its company and group; the helpers answer only for what the caller
 * writes; and the fiscal-period census still counts a group's adjustment after the company has left the group.
 * (The outsider and group-gate cases are in company-groups-rls*.int.test.ts.)
 *
 * Real PostgreSQL, the real service functions; synthetic rows only. Fixture route: isaflow_schema_fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { groupsFixture } from './helpers/companyGroupsRlsFixture';
import { IntercompanyMatchRefusedError, matchIntercompanyTransactions } from '@/modules/accounting/services/reports/intercompanyService';
import { removeCoaMapping, setCoaMapping } from '@/modules/accounting/services/reports/groupCoaMappingService';
import { countFiscalPeriodReferences } from '@/modules/accounting/services/gl/fiscalPeriodReferences';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const F = groupsFixture(pool);
const { co, u, g, row } = F;
const DENIED = '42501';
const FROZEN = '23514';

beforeAll(() => F.setup(), 60000);
afterAll(async () => { await F.cleanup(); await pool.end(); });

const asService = <T>(user: string, company: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  F.asAppUser(user, company, (client) => als.run({ client, userId: user, companyId: company, claims: {} } as never, () => fn(client)));
const setActive = (q: PoolClient, company: string) => q.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
const setUser = (q: PoolClient, user: string) => q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);

describe('intercompany_transactions: changed by the writer of a party, and only its status (B1, T1, T5)', () => {
  const status = "UPDATE intercompany_transactions SET match_status = 'matched', matched_at = NOW() WHERE id = $1";
  it('a reader of the group changes nothing', async () => {
    await F.asAppUser(u.UV, co.A3, async (q) => expect((await q.query(status, [row.txA1A4])).rowCount).toBe(0));
  });
  it('a group writer who writes neither party cannot touch the row; a writer of the source or of the target can', async () => {
    await F.asAppUser(u.UW, co.A1, async (q) => {            // owner of A1, viewer of A4: A1 -> A4 by its source, A4 -> A4 by nothing
      expect((await q.query(status, [row.txA1A4])).rowCount).toBe(1);
      expect((await q.query(status, [row.txA4])).rowCount).toBe(0);
    });
    await F.asAppUser(u.UX, co.A4, async (q) => {            // owner of A4 only: the TARGET of A1 -> A4, both sides of A4 -> A4
      expect((await q.query(status, [row.txA1A4])).rowCount).toBe(1);
      expect((await q.query(status, [row.txA4])).rowCount).toBe(1);
    });
  });
  it('a writer of a party that has left the group changes nothing in it, though it still reads the group', async () => {
    await F.asAppUser(u.UY, co.A4, async (q) => {            // owner of A4, viewer of A1: A4's retirement leaves it a reader of GA
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4]);
      expect(await F.visible(q, 'intercompany_transactions', [row.txA1A4])).toEqual([row.txA1A4]);
      expect((await q.query(status, [row.txA1A4])).rowCount).toBe(0);
    });
  });
  it('what was recorded is frozen: amount, currency, type, date, description, parties, journals (a writer of a party included)', async () => {
    await F.asAppUser(u.UW, co.A1, async (q) => {
      for (const [set, value] of [['amount', 1], ['currency', 'USD'], ['transaction_type', 'sale'], ['transaction_date', '2026-04-01'],
        ['description', 'rewritten'], ['target_journal_entry_id', row.jeA4], ['source_journal_entry_id', row.jeA1]]) {
        expect(await F.codeOf(q, `UPDATE intercompany_transactions SET ${set} = $2 WHERE id = $1`, [row.txA1A4, value]), set).toBe(FROZEN);
      }
    });
  });
  it('matching through the service updates both rows (the writer of A1 and A4 writes both parties)', async () => {
    await asService(u.UA, co.A1, async (client) => {
      await matchIntercompanyTransactions(row.txA1A4, row.txA4, g.GA);
      const r = await client.query('SELECT id, match_status, variance_amount FROM intercompany_transactions WHERE id = ANY($1::uuid[]) ORDER BY 1', [[row.txA1A4, row.txA4]]);
      expect(r.rows.map((x: { match_status: string }) => x.match_status)).toEqual(['variance', 'variance']);
      expect(Number(r.rows[0].variance_amount)).toBe(93);
    });
  });
  it('matching a pair the writer does not write on both rows is refused and changes neither row', async () => {
    // UW owns A1 only: txA1A4 (source A1) is writable, txA4 (A4 -> A4) is not, so row security would change 1 of 2.
    await asService(u.UW, co.A1, async (client) => {
      const before = (await client.query('SELECT id, match_status FROM intercompany_transactions WHERE id = ANY($1::uuid[]) ORDER BY 1', [[row.txA1A4, row.txA4]])).rows;
      await expect(matchIntercompanyTransactions(row.txA1A4, row.txA4, g.GA)).rejects.toBeInstanceOf(IntercompanyMatchRefusedError);
      const after = (await client.query('SELECT id, match_status FROM intercompany_transactions WHERE id = ANY($1::uuid[]) ORDER BY 1', [[row.txA1A4, row.txA4]])).rows;
      expect(after).toEqual(before);
    });
  });
  it('a company that has left the group is no source of a new transaction (T5)', async () => {
    const TXP = `INSERT INTO intercompany_transactions (group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date)
                 VALUES ($1, $2, $3, 'loan', 1, '2026-03-02')`;
    await F.asAppUser(u.UA, co.A4, async (q) => {
      expect(await F.codeOf(q, TXP, [g.GA, co.A4, co.A1])).toBe('ok');
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4]);
      expect(await F.codeOf(q, TXP, [g.GA, co.A4, co.A1])).toBe(DENIED);
    });
  });
});

describe('the helpers answer only for what the caller writes (B4)', () => {
  const parties = (q: PoolClient) => q.query('SELECT public.rls_intercompany_parties_ok($1, $2, $3, NULL, NULL) AS ok', [g.GA, co.A1, co.A4]).then((r) => r.rows[0].ok);
  const mapping = (q: PoolClient) => q.query('SELECT public.rls_coa_mapping_ok($1, $2, $3, $4) AS ok', [g.GA, row.gaAcct, co.A1, row.glA1]).then((r) => r.rows[0].ok);
  it('an outsider and a reader get false; a writer gets the truth', async () => {
    expect(await F.asAppUser(u.UC, co.C, parties)).toBe(false);
    expect(await F.asAppUser(u.UV, co.A3, parties)).toBe(false);
    expect(await F.asAppUser(u.UA, co.A1, parties)).toBe(true);
    expect(await F.asAppUser(u.UC, co.C, mapping)).toBe(false);
    expect(await F.asAppUser(u.UV, co.A3, mapping)).toBe(false);
    expect(await F.asAppUser(u.UA, co.A1, mapping)).toBe(true);
  });
  it('the helpers are hardened: definer owned by migration_admin, pinned search_path ending in pg_temp, no PUBLIC, app_user only (T8)', async () => {
    // app_definer_reviews / app_pool_reach_violations (930) gate the body hash only; the rest is pinned here.
    const r = await pool.query(`SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_exec,
        (SELECT count(*)::int FROM public.app_definer_reviews d WHERE d.signature = p.oid::regprocedure::text) AS reviewed
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rls\_%' OR p.proname = 'consolidation_adjustments_on_company_periods') ORDER BY 1`);
    expect(r.rows.map((x: { proname: string }) => x.proname)).toEqual(['consolidation_adjustments_on_company_periods', 'rls_coa_mapping_ok', 'rls_group_may_bootstrap',
      'rls_intercompany_parties_ok', 'rls_user_group_ids', 'rls_user_write_company_ids', 'rls_user_write_group_ids']);
    for (const f of r.rows) {
      expect(f.prosecdef, f.proname).toBe(true);
      expect(f.owner, f.proname).toBe('migration_admin');
      expect(f.proconfig, f.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(f.public_exec, f.proname).toBe(false);
      expect(f.app_exec, f.proname).toBe(true);
      expect(f.reviewed, f.proname).toBe(1);
    }
  });
});

describe('group_coa_mappings: written by a writer of the group and of the company; the accounts belong (B3, B5, T4)', () => {
  const MAP = 'INSERT INTO group_coa_mappings (group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4)';
  it('a mapping to another tenant\'s account, or to another group\'s account, is refused; a proper one is stored', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, MAP, [g.GA, row.gaAcct, co.A1, row.glB1])).toBe(DENIED);   // B1's account as A1's
      expect(await F.codeOf(q, MAP, [g.GA, row.gbAcct, co.A1, row.glA1])).toBe(DENIED);   // GB's account in GA
      expect(await F.codeOf(q, MAP, [g.GA, row.gaAcct, co.A1, row.glA1])).toBe('ok');
      expect(await F.codeOf(q, 'UPDATE group_coa_mappings SET group_account_id = $2 WHERE id = $1', [row.mapA, row.gbAcct])).toBe(DENIED);
      expect(await F.codeOf(q, 'UPDATE group_coa_mappings SET company_account_id = $2 WHERE id = $1', [row.mapA, row.glB1])).toBe(DENIED);
    });
  });
  it('a viewer of the company changes and deletes nothing; its writer does, through the service', async () => {
    await F.asAppUser(u.UV, co.A1, async (q) => {
      expect((await q.query('UPDATE group_coa_mappings SET created_at = NOW()')).rowCount).toBe(0);
      expect((await q.query('DELETE FROM group_coa_mappings WHERE id = $1', [row.mapA])).rowCount).toBe(0);
      expect((await q.query('DELETE FROM group_coa_mappings')).rowCount).toBe(0);
    });
    await asService(u.UA, co.A1, async (client) => {
      const m = await setCoaMapping(g.GA, co.A1, row.glA1, row.gaAcct);
      expect(m.companyAccountId).toBe(row.glA1);
      await removeCoaMapping(m.id, g.GA);
      expect((await client.query('SELECT 1 FROM group_coa_mappings WHERE id = $1', [m.id])).rowCount).toBe(0);
      expect((await client.query('SELECT 1 FROM group_coa_mappings WHERE id = $1', [row.mapA])).rowCount).toBe(1);
      await removeCoaMapping(row.mapA, g.GA);
      expect((await client.query('SELECT 1 FROM group_coa_mappings WHERE id = $1', [row.mapA])).rowCount).toBe(0);
    });
  });
  it('a writer of the group who only views the mapped company, and a writer of the company who has left the group, change nothing', async () => {
    const MAP4 = 'INSERT INTO group_coa_mappings (group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4)';
    await F.asAppUser(u.UW, co.A4, async (q) => {            // UW writes GA through A1, and only views A4
      expect((await q.query('DELETE FROM group_coa_mappings WHERE id = $1', [row.mapA4])).rowCount).toBe(0);
      expect((await q.query('UPDATE group_coa_mappings SET created_at = NOW() WHERE id = $1', [row.mapA4])).rowCount).toBe(0);
      expect(await F.codeOf(q, MAP4, [g.GA, row.gaAcct, co.A4, row.glA4])).toBe(DENIED);   // nor map it: a writer of the group is not a writer of A4
    });
    await F.asAppUser(u.UY, co.A4, async (q) => {
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4]);
      expect((await q.query('DELETE FROM group_coa_mappings WHERE id = $1', [row.mapA4])).rowCount).toBe(0);
      expect((await q.query('UPDATE group_coa_mappings SET created_at = NOW() WHERE id = $1', [row.mapA4])).rowCount).toBe(0);
      expect(await F.codeOf(q, MAP4, [g.GA, row.gaAcct, co.A4, row.glA4])).toBe(DENIED);
    });
  });
  it('a foreign group\'s mapping is neither deleted nor changed', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect((await q.query('DELETE FROM group_coa_mappings WHERE id = $1', [row.mapB])).rowCount).toBe(0);
      expect((await q.query('DELETE FROM group_coa_mappings')).rowCount).toBe(2);   // only its own GA mappings (A1's and A4's), never GB's
    });
  });
});

describe('company_relationships and intercompany_eliminations: viewers write nothing (B3, T6)', () => {
  it('a viewer of either end cannot withdraw a link; a writer of the child can revive one', async () => {
    await F.asAppUser(u.UV, co.A1, async (q) => {   // viewer of A1, the parent of relA
      expect((await q.query('UPDATE company_relationships SET deleted_at = NOW() WHERE id = $1', [row.relA])).rowCount).toBe(0);
      expect((await q.query('UPDATE company_relationships SET created_at = NOW()')).rowCount).toBe(0);
    });
    await F.asAppUser(u.UB, co.B1, async (q) => {   // B1 is the child of relAtoB
      expect((await q.query('UPDATE company_relationships SET deleted_at = NOW() WHERE id = $1', [row.relAtoB])).rowCount).toBe(1);
      expect((await q.query('UPDATE company_relationships SET deleted_at = NULL WHERE id = $1', [row.relAtoB])).rowCount).toBe(1);
    });
  });
  it('a link is created only by a parent the user belongs to (the active-company claim alone is not enough)', async () => {
    await F.asAppUser(u.UA, co.B1, async (q) => {   // a forged active company: UA is no member of B1
      expect(await F.codeOf(q, 'INSERT INTO company_relationships (parent_company_id, child_company_id) VALUES ($1, $2)', [co.B1, co.A1])).toBe(DENIED);
    });
  });
  it('a viewer of the parent company reads its eliminations and writes none', async () => {
    const ELIM = `INSERT INTO intercompany_eliminations (group_company_id, from_company_id, to_company_id, period_start, period_end, elimination_type, amount)
                  VALUES ($1, $1, $2, '2026-04-01', '2026-04-30', 'revenue_expense', 1)`;
    await F.asAppUser(u.UV, co.A1, async (q) => {
      expect(await F.visible(q, 'intercompany_eliminations', [row.elimA])).toEqual([row.elimA]);
      expect(await F.codeOf(q, ELIM, [co.A1, co.A2])).toBe(DENIED);
      expect((await q.query('UPDATE intercompany_eliminations SET amount = 9')).rowCount).toBe(0);
      expect((await q.query('DELETE FROM intercompany_eliminations')).rowCount).toBe(0);
    });
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect((await q.query('UPDATE intercompany_eliminations SET amount = 9 WHERE id = $1', [row.elimA])).rowCount).toBe(1);
    });
  });
});

describe('the fiscal-period census still counts a group\'s adjustment after the company left (S5)', () => {
  it('through the real countFiscalPeriodReferences, as the leaver\'s own session', async () => {
    await asService(u.UX, co.A4, async (client) => {
      expect((await countFiscalPeriodReferences(co.A4)).consolidationAdjustments).toBe(1);
      await client.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4]);
      expect((await client.query('SELECT 1 FROM consolidation_adjustments WHERE id = $1', [row.adjP])).rowCount).toBe(0);   // the session no longer sees it
      expect((await countFiscalPeriodReferences(co.A4)).consolidationAdjustments).toBe(1);                                    // the census still does
    });
  });
  it('and answers only for a company the caller belongs to', async () => {
    await F.asAppUser(u.UC, co.C, async (q) => {
      expect(await F.codeOf(q, 'SELECT public.consolidation_adjustments_on_company_periods($1)', [co.A4])).toBe(DENIED);
    });
  });
});
