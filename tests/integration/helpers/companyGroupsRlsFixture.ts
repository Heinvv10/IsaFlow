/**
 * Shared by the company-groups RLS suites (migration 999r): five companies and four users, three groups
 * and one row in every group-keyed table, written as the owner; and an app_user session opened exactly as
 * withAuth opens one. Real PostgreSQL; synthetic rows only.
 *
 *   UA  owner of A1, A2 and A4   UV  viewer of A1, owner of A3    UW  owner of A1, viewer of A4
 *   UX  owner of A4 only         UY  owner of A4, viewer of A1
 *   UB  owner of B1 and B2       UC  owner of C (in no group)
 *   GA  created by UA, members A1 and A4   GB  created by UB, members B1 (holding) and B2
 *   GE  created by UA, never had a member (the bootstrap case)
 *   GC  created by UV, member A3: UV WRITES GC and only READS GA (the move-between-groups case)
 */
import type { Pool, PoolClient } from 'pg';

const id = (): string => crypto.randomUUID();

export function groupsFixture(pool: Pool) {
  const co = { A1: id(), A2: id(), A3: id(), A4: id(), B1: id(), B2: id(), C: id() };
  const u = { UA: id(), UV: id(), UW: id(), UX: id(), UY: id(), UB: id(), UC: id() };
  const g = { GA: id(), GB: id(), GE: id(), GC: id() };
  const row = { gaAcct: id(), gbAcct: id(), glA1: id(), glB1: id(), mapB: id(), txB: id(), adjA: id(), adjB: id(),
    relA: id(), relB: id(), relAtoB: id(), elimA: id(), elimB: id(), adjC: id(), gcAcct: id(), txC: id(), jeA1: id(), jeA4: id(), txA1A4: id(), txA4: id(), mapA: id(), glA1b: id(), fyA4: id(), fpA4: id(), adjP: id(), glA4: id(), mapA4: id() };

  async function setup(): Promise<void> {
    for (const [k, v] of Object.entries(co)) await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [v, `CG999r ${k}`]);
    for (const [k, v] of Object.entries(u)) await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [v, `${k}-${v}@test.local`]);
    const members: Array<[string, string, string]> = [
      [co.A1, u.UA, 'owner'], [co.A2, u.UA, 'owner'], [co.A1, u.UV, 'viewer'], [co.A3, u.UV, 'owner'],
      [co.A4, u.UA, 'owner'], [co.A1, u.UW, 'owner'], [co.A4, u.UW, 'viewer'], [co.A4, u.UX, 'owner'], [co.A4, u.UY, 'owner'], [co.A1, u.UY, 'viewer'],
      [co.B1, u.UB, 'owner'], [co.B2, u.UB, 'owner'], [co.C, u.UC, 'owner'],
    ];
    for (const [c, user, role] of members) await pool.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [c, user, role]);
    await pool.query('INSERT INTO company_groups (id, name, holding_company_id, created_by) VALUES ($1, $2, $3, $4::UUID), ($5, $6, $7, $8::UUID), ($9, $10, NULL, $4::UUID)',
      [g.GA, 'CG999r GA', co.A1, u.UA, g.GB, 'CG999r GB', co.B1, u.UB, g.GE, 'CG999r GE']);
    await pool.query(`INSERT INTO company_group_members (group_id, company_id, is_holding) VALUES ($1, $2, true), ($1, $6, false), ($3, $4, true), ($3, $5, false)`,
      [g.GA, co.A1, g.GB, co.B1, co.B2, co.A4]);
    await pool.query(`INSERT INTO gl_journal_entries (id, company_id, entry_date, created_by) VALUES ($1, $2, '2026-03-01', $5), ($3, $4, '2026-03-01', $5)`,
      [row.jeA1, co.A1, row.jeA4, co.A4, u.UA]);
    await pool.query('INSERT INTO company_groups (id, name, created_by) VALUES ($1, $2, $3::UUID)', [g.GC, 'CG999r GC', u.UV]);
    await pool.query('INSERT INTO company_group_members (group_id, company_id) VALUES ($1, $2)', [g.GC, co.A3]);
    await pool.query(`INSERT INTO group_accounts (id, group_id, account_code, account_name, account_type) VALUES ($1, $2, '1000', 'A bank', 'asset'), ($3, $4, '1000', 'B bank', 'asset'), ($5, $6, '1000', 'C bank', 'asset')`,
      [row.gaAcct, g.GA, row.gbAcct, g.GB, row.gcAcct, g.GC]);
    await pool.query(`INSERT INTO intercompany_transactions (id, group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date) VALUES ($1, $2, $3, $3, 'loan', 1, '2026-03-01')`,
      [row.txC, g.GC, co.A3]);
    await pool.query(`INSERT INTO consolidation_adjustments (id, group_id, adjustment_type) VALUES ($1, $2, 'interco_balance')`, [row.adjC, g.GC]);
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active) VALUES ($1, $2, 'CG-1', 'A1 bank', 'asset', 'debit', 3, true), ($3, $4, 'CG-1', 'B1 bank', 'asset', 'debit', 3, true)`,
      [row.glA1, co.A1, row.glB1, co.B1]);
    await pool.query('INSERT INTO group_coa_mappings (id, group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4, $5)', [row.mapB, g.GB, row.gbAcct, co.B1, row.glB1]);
    await pool.query(`INSERT INTO intercompany_transactions (id, group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date) VALUES ($1, $2, $3, $4, 'loan', 10, '2026-03-01')`,
      [row.txB, g.GB, co.B1, co.B2]);
    await pool.query(`INSERT INTO consolidation_adjustments (id, group_id, adjustment_type) VALUES ($1, $2, 'interco_balance'), ($3, $4, 'interco_balance')`, [row.adjA, g.GA, row.adjB, g.GB]);
    // GA's own rows: a transaction A1 -> A4, one A4 -> A4 (a writer of A1 writes neither side of it), a mapping for A1.
    await pool.query(`INSERT INTO intercompany_transactions (id, group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date, description)
      VALUES ($1, $2, $3, $4, 'loan', 100, '2026-03-01', 'orig'), ($5, $2, $4, $4, 'loan', 7, '2026-03-01', 'orig')`, [row.txA1A4, g.GA, co.A1, co.A4, row.txA4]);
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active) VALUES ($1, $2, 'CG-2', 'A1 other', 'asset', 'debit', 3, true)`, [row.glA1b, co.A1]);
    await pool.query('INSERT INTO group_coa_mappings (id, group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4, $5)', [row.mapA, g.GA, row.gaAcct, co.A1, row.glA1b]);
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active) VALUES ($1, $2, 'CG-4', 'A4 bank', 'asset', 'debit', 3, true)`, [row.glA4, co.A4]);
    await pool.query('INSERT INTO group_coa_mappings (id, group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4, $5)', [row.mapA4, g.GA, row.gaAcct, co.A4, row.glA4]);
    // A4's fiscal period, and a GA adjustment that points at it (the census of a period rebuild counts it).
    await pool.query(`INSERT INTO fiscal_years (id, company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, $2, 2026, '2026-03-01', '2027-02-28', 'normal')`, [row.fyA4, co.A4]);
    await pool.query(`INSERT INTO fiscal_periods (id, company_id, period_name, period_number, fiscal_year, start_date, end_date, fiscal_year_id) VALUES ($1, $2, 'P1', 1, 2026, '2026-03-01', '2026-03-31', $3)`, [row.fpA4, co.A4, row.fyA4]);
    await pool.query(`INSERT INTO consolidation_adjustments (id, group_id, adjustment_type, fiscal_period_id) VALUES ($1, $2, 'interco_balance', $3)`, [row.adjP, g.GA, row.fpA4]);
    await pool.query(`INSERT INTO company_relationships (id, parent_company_id, child_company_id) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $2, $5)`,
      [row.relA, co.A1, co.A2, row.relB, co.B1, co.B2, row.relAtoB]);
    await pool.query(`INSERT INTO intercompany_eliminations (id, group_company_id, from_company_id, to_company_id, period_start, period_end, elimination_type, amount)
      VALUES ($1, $2, $2, $3, '2026-03-01', '2026-03-31', 'receivable_payable', 5), ($4, $5, $5, $6, '2026-03-01', '2026-03-31', 'receivable_payable', 5)`,
      [row.elimA, co.A1, co.A2, row.elimB, co.B1, co.B2]);
  }

  async function cleanup(): Promise<void> {
    const cos = Object.values(co), gs = Object.values(g);
    await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = ANY($1)', [gs]);
    await pool.query('DELETE FROM intercompany_transactions WHERE group_id = ANY($1)', [gs]);
    await pool.query('DELETE FROM group_coa_mappings WHERE group_id = ANY($1)', [gs]);
    await pool.query('DELETE FROM group_accounts WHERE group_id = ANY($1)', [gs]);
    await pool.query('DELETE FROM company_group_members WHERE group_id = ANY($1)', [gs]);
    await pool.query('DELETE FROM company_groups WHERE id = ANY($1)', [gs]);
    await pool.query('DELETE FROM company_relationships WHERE parent_company_id = ANY($1) OR child_company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM intercompany_eliminations WHERE group_company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM fiscal_years WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [Object.values(u)]);
  }

  /** A transaction as withAuth opens one: app_user, the member's claims, the active company. Always rolled back. */
  async function asAppUser<T>(user: string, company: string, fn: (q: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  /** 'ok', or the SQLSTATE (and constraint) a statement fails with. Runs in a savepoint so the session stays usable. */
  async function codeOf(q: PoolClient, text: string, params: unknown[] = []): Promise<string> {
    await q.query('SAVEPOINT cg_probe');
    try {
      await q.query(text, params);
      await q.query('RELEASE SAVEPOINT cg_probe');
      return 'ok';
    } catch (err) {
      await q.query('ROLLBACK TO SAVEPOINT cg_probe');
      const e = err as { code?: string; constraint?: string };
      return e.constraint ? `${e.code}:${e.constraint}` : String(e.code);
    }
  }

  /** Ids of the rows `q` can see in `table` (optionally narrowed to `where`), as the session's role. */
  async function visible(q: PoolClient, table: string, ids: string[], col = 'id'): Promise<string[]> {
    const r = await q.query(`SELECT ${col}::text AS k FROM ${table} WHERE ${col} = ANY($1::uuid[]) ORDER BY 1`, [ids]);
    return r.rows.map((x: { k: string }) => x.k).sort();
  }

  return { co, u, g, row, setup, cleanup, asAppUser, codeOf, visible };
}
