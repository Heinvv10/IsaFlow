/**
 * Migration 999r, round 2, as app_user: what a consolidation adjustment may point at, a session that clears its claims
 * mid-statement, the census definer asked without claims, and the frozen fields of a transaction (created_at, matched_by);
 * and the group services under the narrower policies (re-join, remove, match: never a silent or partial success).
 *
 * Real PostgreSQL, the real service functions; synthetic rows only. Fixture route: isaflow_schema_fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { groupsFixture } from './helpers/companyGroupsRlsFixture';
import { addMember, findMember, removeMember } from '@/modules/accounting/services/reports/groupCrudService';
import { getTransactionParties, matchIntercompanyTransactions } from '@/modules/accounting/services/reports/intercompanyService';

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
/** The message of the error a statement raises, or null. */
async function messageOf(q: PoolClient, text: string, params: unknown[] = []): Promise<string | null> {
  await q.query('SAVEPOINT msg_probe');
  try { await q.query(text, params); await q.query('RELEASE SAVEPOINT msg_probe'); return null; }
  catch (err) { await q.query('ROLLBACK TO SAVEPOINT msg_probe'); return (err as Error).message; }
}

describe('consolidation_adjustments: what an adjustment points at (6)', () => {
  const ADJ = "INSERT INTO consolidation_adjustments (group_id, adjustment_type, fiscal_period_id, source_intercompany_id) VALUES ($1, 'interco_balance', $2, $3)";
  it('a period of a current member company, or none, and a transaction of the same group', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, ADJ, [g.GA, null, null])).toBe('ok');
      expect(await F.codeOf(q, ADJ, [g.GA, row.fpA4, null])).toBe('ok');
      expect(await F.codeOf(q, ADJ, [g.GA, null, row.txA1A4])).toBe('ok');
    });
  });
  it('a period of another tenant, of a company outside the group, or of one that left, is refused', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, ADJ, [g.GA, row.fpB1, null]), 'another tenant\'s period').toBe(DENIED);
      expect(await F.codeOf(q, ADJ, [g.GA, row.fpA2, null]), 'a non-member\'s period').toBe(DENIED);
      await setActive(q, co.A4);
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4]);
      await setActive(q, co.A1);
      expect(await F.codeOf(q, ADJ, [g.GA, row.fpA4, null]), 'a leaver\'s period').toBe(DENIED);
    });
  });
  it('a transaction of another group is refused as the source', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => expect(await F.codeOf(q, ADJ, [g.GA, null, row.txB])).toBe(DENIED));
  });
  it('the group, period and source of a stored adjustment never change; its status does, even after the company left', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      for (const [set, value] of [['fiscal_period_id', row.fpA2], ['source_intercompany_id', row.txB], ['group_id', g.GC]]) {
        expect(await F.codeOf(q, `UPDATE consolidation_adjustments SET ${set} = $2 WHERE id = $1`, [row.adjP, value]), set).toBe(FROZEN);
      }
      await setActive(q, co.A4);
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4]);
      await setActive(q, co.A1);
      expect((await q.query("UPDATE consolidation_adjustments SET status = 'posted' WHERE id = $1", [row.adjP])).rowCount).toBe(1);
    });
  });
  it('the helper answers false for a group the caller does not write', async () => {
    const ok = (q: PoolClient) => q.query('SELECT public.rls_adjustment_refs_ok($1, $2, NULL) AS ok', [g.GA, row.fpA4]).then((r) => r.rows[0].ok);
    expect(await F.asAppUser(u.UC, co.C, ok)).toBe(false);
    expect(await F.asAppUser(u.UV, co.A3, ok)).toBe(false);
    expect(await F.asAppUser(u.UA, co.A1, ok)).toBe(true);
  });
});

describe('a session that clears its claims mid-statement is refused (7, 8)', () => {
  const clear = "(SELECT set_config('request.jwt.claims', '', true))";
  it('company_groups: a foreign holding company or another created_by, with the claims cleared in the SET list', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await messageOf(q, `UPDATE company_groups SET holding_company_id = $2, name = ${clear} WHERE id = $1`, [g.GA, co.B1])).toMatch(/no claims on this statement/);
    });
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await messageOf(q, `UPDATE company_groups SET created_by = $2::UUID, name = ${clear} WHERE id = $1`, [g.GA, u.UB])).toMatch(/no claims on this statement/);
    });
  });
  it('a claim-less path in no app role (a migration, the service pool) is still answered', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect((await c.query('UPDATE company_groups SET holding_company_id = $2 WHERE id = $1', [g.GA, co.B1])).rowCount).toBe(1);
      expect((await c.query('SELECT public.consolidation_adjustments_on_company_periods($1) AS n', [co.A4])).rows[0].n).toBe(1);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
  it('the census definer refuses an app_user whose claims are cleared, and one that is no member', async () => {
    await F.asAppUser(u.UX, co.A4, async (q) => {
      expect(await F.codeOf(q, 'SELECT public.consolidation_adjustments_on_company_periods($1)', [co.A4])).toBe('ok');
      await q.query("SELECT set_config('request.jwt.claims', '', true)");
      expect(await F.codeOf(q, 'SELECT public.consolidation_adjustments_on_company_periods($1)', [co.A4])).toBe(DENIED);
    });
  });
});

describe('intercompany_transactions: created_at is frozen and matched_by is the caller (9)', () => {
  it('created_at never changes; matched_by may only be set to the caller', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, "UPDATE intercompany_transactions SET created_at = '2001-01-01' WHERE id = $1", [row.txA1A4])).toBe(FROZEN);
      expect(await F.codeOf(q, 'UPDATE intercompany_transactions SET matched_by = $2::UUID WHERE id = $1', [row.txA1A4, u.UB])).toBe(FROZEN);
      expect(await F.codeOf(q, 'UPDATE intercompany_transactions SET matched_by = $2::UUID, match_status = \'matched\', variance_amount = 0, matched_at = NOW() WHERE id = $1', [row.txA1A4, u.UA])).toBe('ok');
    });
  });
});

describe('the services under the narrower policies: nothing is reported done that was not (1, 3, 4)', () => {
  it('a company that left is re-activated by addMember under the INSERT gate, once; a current member is null', async () => {
    await asService(u.UA, co.A4, async () => {
      const m = (await findMember((await pool.query('SELECT id FROM company_group_members WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4])).rows[0].id, g.GA))!;
      expect(m.companyId).toBe(co.A4);
      expect(await removeMember((await pool.query('SELECT id FROM company_group_members WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4])).rows[0].id, g.GA)).toBe(true);
      const back = await addMember(g.GA, co.A4, { ownershipPct: 40 });
      expect(back).toMatchObject({ companyId: co.A4, leftDate: null, ownershipPct: 40 });
      expect(await addMember(g.GA, co.A4)).toBeNull();
    });
  });
  it('a viewer of the company cannot re-join it, remove it or find it changed', async () => {
    const id = (await pool.query('SELECT id FROM company_group_members WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4])).rows[0].id as string;
    await asService(u.UW, co.A4, async (client) => {       // owner of A1 (writes GA), only a viewer of A4
      expect(await removeMember(id, g.GA)).toBe(false);
      await client.query('SAVEPOINT rejoin');
      await expect(addMember(g.GB, co.A4)).rejects.toMatchObject({ code: DENIED });
      await client.query('ROLLBACK TO SAVEPOINT rejoin');
    });
  });
  it('removeMember is false for a row that is not this group\'s, and for one already retired', async () => {
    const id = (await pool.query('SELECT id FROM company_group_members WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4])).rows[0].id as string;
    await asService(u.UA, co.A4, async () => {
      expect(await removeMember(id, g.GB)).toBe(false);
      expect(await removeMember(id, g.GA)).toBe(true);
      expect(await removeMember(id, g.GA)).toBe(false);
    });
  });
  it('a match that only one of the two rows allows throws, and the route can tell beforehand who writes which party', async () => {
    await asService(u.UW, co.A1, async (client) => {      // UW writes A1 (source of txA1A4), neither party of txA4
      const parties = await getTransactionParties([row.txA1A4, row.txA4], g.GA);
      expect(parties.find((p) => p.id === row.txA1A4)).toMatchObject({ sourceCompanyId: co.A1, targetCompanyId: co.A4 });
      expect(parties.find((p) => p.id === row.txA4)).toMatchObject({ sourceCompanyId: co.A4, targetCompanyId: co.A4 });
      await client.query('SAVEPOINT m');
      await expect(matchIntercompanyTransactions(row.txA1A4, row.txA4, g.GA)).rejects.toThrow(/1 of 2/);
      await client.query('ROLLBACK TO SAVEPOINT m');
    });
    await asService(u.UA, co.A1, async () => {
      await matchIntercompanyTransactions(row.txA1A4, row.txA4, g.GA);              // both parties written: both rows
      await matchIntercompanyTransactions(row.txA1A4, row.txA1A4, g.GA);            // the same row twice is one row
    });
  });
});
