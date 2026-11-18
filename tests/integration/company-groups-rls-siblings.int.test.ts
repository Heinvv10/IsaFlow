/**
 * Migration 999r, the sibling tables of company_groups, as app_user. None of them had row security
 * (group_accounts, intercompany_transactions, consolidation_adjustments, company_relationships,
 * intercompany_eliminations) or checked only the company (group_coa_mappings), so a session read every
 * tenant's group chart, intercompany transactions, adjustments, corporate structure and eliminations,
 * and could write into a group it was not in. Group-keyed tables now follow the group (members read, a
 * writer of a member company writes, as the route guards do); the company-keyed ones follow the company.
 *
 * Real PostgreSQL; synthetic rows only. Fixture route: isaflow_schema_fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import {
  createEliminationAdjustment, getEliminationAdjustments, postEliminationAdjustment, reverseEliminationAdjustment,
} from '@/modules/accounting/services/reports/consolidatedReportingService';
import { createIntercompanyTransaction } from '@/modules/accounting/services/reports/intercompanyService';
import { createGroupAccount, getGroupAccounts, deleteGroupAccount } from '@/modules/accounting/services/reports/groupCompanyService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { DEFAULT_WRITE_ROLES } from '@/lib/auth/writeRoles';
import { groupsFixture } from './helpers/companyGroupsRlsFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const F = groupsFixture(pool);
const { co, u, g, row } = F;
const DENIED = '42501';

beforeAll(() => F.setup(), 60000);
afterAll(async () => { await F.cleanup(); await pool.end(); });

const ACCOUNT = 'INSERT INTO group_accounts (group_id, account_code, account_name, account_type) VALUES ($1, $2, $2, \'asset\')';
const TX = `INSERT INTO intercompany_transactions (group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date)
            VALUES ($1, $2, $2, 'loan', 1, '2026-03-02')`;
const ADJ = "INSERT INTO consolidation_adjustments (group_id, adjustment_type) VALUES ($1, 'interco_balance')";

describe('group-keyed tables: members read, a writer of a member company writes', () => {
  const tables: Array<[string, string, string]> = [
    ['group_accounts', row.gaAcct, row.gbAcct], ['intercompany_transactions', row.txB, row.txB],
    ['consolidation_adjustments', row.adjA, row.adjB], ['group_coa_mappings', row.mapB, row.mapB],
  ];
  it('a member reads its group\'s rows and a stranger reads none', async () => {
    expect(await F.asAppUser(u.UA, co.A1, (q) => F.visible(q, 'group_accounts', [row.gaAcct, row.gbAcct]))).toEqual([row.gaAcct]);
    expect(await F.asAppUser(u.UV, co.A3, (q) => F.visible(q, 'consolidation_adjustments', [row.adjA, row.adjB]))).toEqual([row.adjA]);
    expect(await F.asAppUser(u.UB, co.B1, (q) => F.visible(q, 'intercompany_transactions', [row.txB]))).toEqual([row.txB]);
    for (const [t, a, b] of tables) {
      expect(await F.asAppUser(u.UC, co.C, (q) => F.visible(q, t, [a, b])), `${t} read by a stranger`).toEqual([]);
    }
    expect(await F.asAppUser(u.UA, co.A1, (q) => F.visible(q, 'intercompany_transactions', [row.txB]))).toEqual([]);
    expect(await F.asAppUser(u.UA, co.A1, (q) => F.visible(q, 'group_coa_mappings', [row.mapB]))).toEqual([]);
  });
  it('a session cannot write into a group it is not a member of', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, ACCOUNT, [g.GB, 'X1'])).toBe(DENIED);
      expect(await F.codeOf(q, TX, [g.GB, co.A1])).toBe(DENIED);
      expect(await F.codeOf(q, ADJ, [g.GB])).toBe(DENIED);
      expect((await q.query("UPDATE group_accounts SET account_name = 'x' WHERE id = $1", [row.gbAcct])).rowCount).toBe(0);
      expect((await q.query('DELETE FROM consolidation_adjustments WHERE id = $1', [row.adjB])).rowCount).toBe(0);
    });
    expect((await pool.query('SELECT count(*)::int AS n FROM consolidation_adjustments WHERE id = $1', [row.adjB])).rows[0].n).toBe(1);
  });
  it('a viewer of a member company reads but cannot write', async () => {
    await F.asAppUser(u.UV, co.A3, async (q) => {
      expect(await F.codeOf(q, ACCOUNT, [g.GA, 'X2'])).toBe(DENIED);
      expect(await F.codeOf(q, ADJ, [g.GA])).toBe(DENIED);
      for (const [table, id] of [['group_accounts', row.gaAcct], ['consolidation_adjustments', row.adjA]]) {
        expect((await q.query(`UPDATE ${table} SET created_at = NOW() WHERE id = $1`, [id])).rowCount, `update ${table}`).toBe(0);
        expect((await q.query(`DELETE FROM ${table} WHERE id = $1`, [id])).rowCount, `delete ${table}`).toBe(0);
      }
    });
  });
  it('a writer of a member company writes its own group', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, ACCOUNT, [g.GA, 'X3'])).toBe('ok');
      expect(await F.codeOf(q, TX, [g.GA, co.A1])).toBe('ok');
      expect(await F.codeOf(q, ADJ, [g.GA])).toBe('ok');
      expect((await q.query("UPDATE consolidation_adjustments SET status = 'posted' WHERE id = $1", [row.adjA])).rowCount).toBe(1);
      expect((await q.query('DELETE FROM group_accounts WHERE id = $1', [row.gaAcct])).rowCount).toBe(1);
    });
  });
  it('a row cannot be moved into a group the writer does not write (foreign, or one it only reads)', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, 'UPDATE consolidation_adjustments SET group_id = $2 WHERE id = $1', [row.adjA, g.GB])).toBe('23514');   // the adjustment's keys-immutable trigger
    });
    // UV writes GC (owner of A3) and only reads GA (viewer of A1): GA is visible to it, so only the write check stops the move.
    await F.asAppUser(u.UV, co.A3, async (q) => {
      for (const [table, id] of [['consolidation_adjustments', row.adjC], ['group_accounts', row.gcAcct], ['intercompany_transactions', row.txC]]) {
        // consolidation_adjustments and intercompany_transactions are stopped earlier, by their keys-immutable triggers;
        // group_accounts by the UPDATE policy.
        expect(await F.codeOf(q, `UPDATE ${table} SET group_id = $2 WHERE id = $1`, [id, g.GA]), table)
          .toBe(table === 'group_accounts' ? DENIED : '23514');
      }
    });
  });
});

describe('intercompany_transactions: both parties are current members, the source is one the writer writes', () => {
  const TXP = `INSERT INTO intercompany_transactions (group_id, source_company_id, target_company_id, source_journal_entry_id, target_journal_entry_id, transaction_type, amount, transaction_date)
               VALUES ($1, $2, $3, $4, $5, 'loan', 1, '2026-03-02')`;
  it('a writer records a transaction between two current members, with journals of those companies', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, TXP, [g.GA, co.A1, co.A4, null, null])).toBe('ok');
      expect(await F.codeOf(q, TXP, [g.GA, co.A1, co.A4, row.jeA1, row.jeA4])).toBe('ok');
    });
  });
  it('a company outside the group, or one that has left it, is refused on either side', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, TXP, [g.GA, co.A1, co.A2, null, null])).toBe(DENIED);   // A2 is no member
      expect(await F.codeOf(q, TXP, [g.GA, co.A1, co.B1, null, null])).toBe(DENIED);   // a foreign tenant
      expect(await F.codeOf(q, TXP, [g.GA, co.A2, co.A1, null, null])).toBe(DENIED);   // source: A2 is no member
      await q.query("SELECT set_config('app.current_company_id', $1, true)", [co.A4]);   // a member row is written with its own company active
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [g.GA, co.A4]);
      await q.query("SELECT set_config('app.current_company_id', $1, true)", [co.A1]);
      expect(await F.codeOf(q, TXP, [g.GA, co.A1, co.A4, null, null])).toBe(DENIED);   // A4 has left
    });
  });
  it('the source must be a company the writer holds a write role in', async () => {
    await F.asAppUser(u.UW, co.A1, async (q) => {      // UW owns A1, only views A4
      expect(await F.codeOf(q, TXP, [g.GA, co.A1, co.A4, null, null])).toBe('ok');
      expect(await F.codeOf(q, TXP, [g.GA, co.A4, co.A1, null, null])).toBe(DENIED);
    });
  });
  it('a journal entry must belong to the company it is attached to', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, TXP, [g.GA, co.A1, co.A4, row.jeA4, null])).toBe(DENIED);   // A4's journal on A1's side
      expect(await F.codeOf(q, TXP, [g.GA, co.A1, co.A4, null, row.jeA1])).toBe(DENIED);   // A1's journal on A4's side
    });
  });
  it('the parties of a stored transaction never change (matching still updates its status)', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      const id = (await q.query(`INSERT INTO intercompany_transactions (group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date)
        VALUES ($1, $2, $3, 'loan', 1, '2026-03-02') RETURNING id`, [g.GA, co.A1, co.A4])).rows[0].id as string;
      for (const [set, value] of [['source_company_id', co.A2], ['target_company_id', co.A2], ['group_id', g.GC], ['source_journal_entry_id', row.jeA4]]) {
        expect(await F.codeOf(q, `UPDATE intercompany_transactions SET ${set} = $2 WHERE id = $1`, [id, value]), set).toBe('23514');
      }
      expect(await F.codeOf(q, "UPDATE intercompany_transactions SET match_status = 'matched', matched_at = NOW() WHERE id = $1", [id])).toBe('ok');
    });
  });
});

describe('group_coa_mappings: the mapping\'s group is checked, the company check stays', () => {
  const MAP = 'INSERT INTO group_coa_mappings (group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4)';
  it('a company cannot map its account into a foreign group, nor move a mapping there', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, MAP, [g.GB, row.gbAcct, co.A1, row.glA1])).toBe(DENIED);
      expect(await F.codeOf(q, MAP, [g.GA, row.gaAcct, co.A1, row.glA1])).toBe('ok');
      expect(await F.codeOf(q, 'UPDATE group_coa_mappings SET group_id = $1 WHERE company_id = $2', [g.GB, co.A1])).toBe(DENIED);
    });
  });
  it('a viewer of the group cannot map, and the active-company check still holds', async () => {
    await F.asAppUser(u.UV, co.A1, async (q) => expect(await F.codeOf(q, MAP, [g.GA, row.gaAcct, co.A1, row.glA1])).toBe(DENIED));
    await F.asAppUser(u.UA, co.A2, async (q) => expect(await F.codeOf(q, MAP, [g.GA, row.gaAcct, co.A1, row.glA1])).toBe(DENIED));
  });
});

describe('company_relationships: a cross-tenant read grant, so both ends are checked', () => {
  const LINK = 'INSERT INTO company_relationships (parent_company_id, child_company_id) VALUES ($1, $2)';
  it('a session sees only links its companies are an end of', async () => {
    const all = [row.relA, row.relB, row.relAtoB];
    expect(await F.asAppUser(u.UA, co.A1, (q) => F.visible(q, 'company_relationships', all))).toEqual([row.relA, row.relAtoB].sort());
    expect(await F.asAppUser(u.UB, co.B1, (q) => F.visible(q, 'company_relationships', all))).toEqual([row.relB, row.relAtoB].sort());
    expect(await F.asAppUser(u.UC, co.C, (q) => F.visible(q, 'company_relationships', all))).toEqual([]);
  });
  it('a parent attaches a child it holds a write role in, and nothing else', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, LINK, [co.A1, co.A3])).toBe(DENIED);   // A3: UA is no member
      expect(await F.codeOf(q, LINK, [co.A1, co.C])).toBe(DENIED);
      expect(await F.codeOf(q, LINK, [co.B1, co.A1])).toBe(DENIED);   // a forged parent: B1 is not the active company
      expect(await F.codeOf(q, LINK, [co.A1, co.A2])).toBe('23505:company_relationships_parent_company_id_child_company_id_key');
    });
    await F.asAppUser(u.UV, co.A3, async (q) => expect(await F.codeOf(q, LINK, [co.A3, co.A1])).toBe(DENIED)); // viewer of A1 cannot publish it
    await F.asAppUser(u.UB, co.B1, async (q) => expect(await F.codeOf(q, LINK, [co.B1, co.C])).toBe(DENIED));
  });
  it('either end withdraws a link (soft delete), a stranger cannot', async () => {
    const withdraw = "UPDATE company_relationships SET deleted_at = NOW(), deleted_by = $2::UUID WHERE id = $1";
    await F.asAppUser(u.UB, co.B1, async (q) => expect((await q.query(withdraw, [row.relAtoB, u.UB])).rowCount).toBe(1));   // as the child
    await F.asAppUser(u.UA, co.A1, async (q) => expect((await q.query(withdraw, [row.relA, u.UA])).rowCount).toBe(1));      // as the parent
    await F.asAppUser(u.UC, co.C, async (q) => expect((await q.query(withdraw, [row.relB, u.UC])).rowCount).toBe(0));
  });
  it('a withdrawn link cannot be revived from the parent\'s side: only someone who writes the child may', async () => {
    await F.asAppUser(u.UB, co.B1, async (q) => {
      await q.query('UPDATE company_relationships SET deleted_at = NOW() WHERE id = $1', [row.relAtoB]);    // B1 withdraws
      await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.UA })]);
      await q.query("SELECT set_config('app.current_company_id', $1, true)", [co.A1]);                      // the parent's user
      expect(await F.codeOf(q, 'UPDATE company_relationships SET deleted_at = NULL WHERE id = $1', [row.relAtoB])).toBe(DENIED);
    });
  });
  it('a link cannot be re-pointed at another tenant\'s company, and is never hard-deleted', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, 'UPDATE company_relationships SET child_company_id = $2 WHERE id = $1', [row.relA, co.B1])).toBe('23514');
      expect(await F.codeOf(q, 'UPDATE company_relationships SET parent_company_id = $2, child_company_id = $3 WHERE id = $1', [row.relA, co.B2, co.A2])).toBe('23514');
      expect((await q.query('DELETE FROM company_relationships WHERE id = $1', [row.relA])).rowCount).toBe(0);
    });
  });
  it('the app\'s own revive-on-relink upsert still works', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      await q.query("UPDATE company_relationships SET deleted_at = NOW() WHERE id = $1", [row.relA]);
      const r = await q.query(`INSERT INTO company_relationships (parent_company_id, child_company_id, relationship_type, ownership_percent, created_by)
        VALUES ($1, $2, 'subsidiary', 80, $3::UUID) ON CONFLICT (parent_company_id, child_company_id)
        DO UPDATE SET ownership_percent = EXCLUDED.ownership_percent, created_by = EXCLUDED.created_by, deleted_at = NULL, deleted_by = NULL RETURNING deleted_at`,
      [co.A1, co.A2, u.UA]);
      expect(r.rows[0].deleted_at).toBeNull();
    });
  });
});

describe('intercompany_eliminations: the parent company\'s own rows', () => {
  const ELIM = `INSERT INTO intercompany_eliminations (group_company_id, from_company_id, to_company_id, period_start, period_end, elimination_type, amount)
                VALUES ($1, $1, $2, '2026-04-01', '2026-04-30', 'revenue_expense', 1)`;
  it('a session reads only the eliminations of its own companies', async () => {
    expect(await F.asAppUser(u.UA, co.A1, (q) => F.visible(q, 'intercompany_eliminations', [row.elimA, row.elimB]))).toEqual([row.elimA]);
    expect(await F.asAppUser(u.UC, co.C, (q) => F.visible(q, 'intercompany_eliminations', [row.elimA, row.elimB]))).toEqual([]);
  });
  it('it writes its own and cannot forge another tenant\'s', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, ELIM, [co.A1, co.A2])).toBe('ok');
      expect(await F.codeOf(q, ELIM, [co.B1, co.B2])).toBe(DENIED);
    });
  });
});

// A DELETE or UPDATE with no WHERE reads no column, so the SELECT policy does not narrow it: only the
// command's own policy does, and that is what these pin (a probe that names an id never reaches it).
describe('an unconditional UPDATE or DELETE reaches only the rows the command\'s own policy admits', () => {
  const ALL = ['company_groups', 'company_group_members', 'group_accounts', 'group_coa_mappings', 'intercompany_transactions',
    'consolidation_adjustments', 'company_relationships', 'intercompany_eliminations'];
  it('a company in no group and no link changes and deletes nothing, anywhere', async () => {
    await F.asAppUser(u.UC, co.C, async (q) => {
      for (const t of ALL) {
        expect((await q.query(`UPDATE ${t} SET created_at = NOW()`)).rowCount, `update ${t}`).toBe(0);
        expect((await q.query(`DELETE FROM ${t}`)).rowCount, `delete ${t}`).toBe(0);
      }
    });
  });
  it('a viewer of one group and writer of another reaches only the writer group\'s rows', async () => {
    await F.asAppUser(u.UV, co.A3, async (q) => {
      for (const t of ['group_accounts', 'consolidation_adjustments', 'intercompany_transactions']) {
        // a column the table's triggers leave writable (a transaction's created_at is frozen)
        const col = t === 'intercompany_transactions' ? 'variance_amount = 0' : 'created_at = NOW()';
        expect((await q.query(`UPDATE ${t} SET ${col}`)).rowCount, `update ${t}`).toBe(1);
      }
      expect((await q.query('DELETE FROM group_accounts')).rowCount).toBe(1);   // the chart is edited and pruned by the app
      // Nothing else is ever hard-deleted by the app: adjustments are reversed, transactions kept, groups deactivated.
      for (const t of ['consolidation_adjustments', 'intercompany_transactions', 'company_groups']) {
        expect((await q.query(`DELETE FROM ${t}`)).rowCount, `delete ${t}`).toBe(0);
      }
      expect((await q.query('UPDATE company_groups SET created_at = NOW()')).rowCount).toBe(1);
    });
  });
});

describe('the group services still work as a member writer, through the real service layer', () => {
  const asService = <T>(user: string, company: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    F.asAppUser(user, company, (client) => als.run({ client, userId: user, companyId: company, claims: {} } as never, () => fn(client)));

  it('group chart, intercompany transaction, and the elimination draft -> posted -> reversed life cycle', async () => {
    await asService(u.UA, co.A1, async () => {
      const acct = await createGroupAccount(g.GA, { accountCode: '2000', accountName: 'Interco loan', accountType: 'liability' });
      expect((await getGroupAccounts(g.GA)).map((a) => a.accountCode).sort()).toEqual(['1000', '2000']);
      const tx = await createIntercompanyTransaction({
        groupId: g.GA, sourceCompanyId: co.A1, targetCompanyId: co.A4, transactionType: 'loan', amount: 50, transactionDate: '2026-03-05',
      });
      const adj = await createEliminationAdjustment(g.GA, {
        adjustmentType: 'interco_balance', description: 'x', periodStart: '2026-03-01', periodEnd: '2026-03-31', sourceIntercompanyId: tx.id,
        lines: [{ groupAccountId: acct.id, debit: 50, credit: 0 }, { groupAccountId: row.gaAcct, debit: 0, credit: 50 }],
      } as never);
      expect(adj.adjustmentNumber).toMatch(/^ELIM-2026-\d{5}$/);
      await postEliminationAdjustment(adj.id, g.GA);
      await reverseEliminationAdjustment(adj.id, g.GA);
      expect((await getEliminationAdjustments(g.GA)).map((a) => a.status)).toContain('reversed');
      await deleteGroupAccount(acct.id, g.GA);
    });
  });
  it('a foreign group\'s chart reads empty and its writes are refused', async () => {
    await asService(u.UA, co.A1, async (client) => {
      expect(await getGroupAccounts(g.GB)).toEqual([]);
      await client.query('SAVEPOINT refused');
      await expect(createEliminationAdjustment(g.GB, { adjustmentType: 'interco_balance', description: 'x', periodStart: '2026-03-01', periodEnd: '2026-03-31', lines: [] } as never))
        .rejects.toMatchObject({ code: DENIED });
      await client.query('ROLLBACK TO SAVEPOINT refused');
    });
  });
});

describe('the service pool and the definer registry stay consistent', () => {
  it('the definers\' write-role list is DEFAULT_WRITE_ROLES', async () => {
    const r = await pool.query(`SELECT proname, prosrc FROM pg_proc WHERE proname IN ('rls_user_write_group_ids', 'rls_user_write_company_ids')`);
    expect(r.rows).toHaveLength(2);
    for (const { prosrc } of r.rows) {
      const list = /ARRAY\[([^\]]+)\]/.exec(prosrc as string)?.[1].split(',').map((x) => x.trim().replace(/'/g, ''));
      expect(list).toEqual([...DEFAULT_WRITE_ROLES]);
    }
  });
  it('app_service mirrors every command the new policies admit, and the registry has no violation', async () => {
    expect((await pool.query('SELECT * FROM public.app_service_policy_drift()')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM public.app_pool_reach_violations()')).rows).toEqual([]);
    const t = (await pool.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = ANY($1) ORDER BY 1`, [['company_groups', 'company_group_members', 'group_accounts', 'group_coa_mappings',
      'intercompany_transactions', 'consolidation_adjustments', 'company_relationships', 'intercompany_eliminations']])).rows;
    expect(t.every((r: { relrowsecurity: boolean; relforcerowsecurity: boolean }) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    expect(t).toHaveLength(8);
  });
});
