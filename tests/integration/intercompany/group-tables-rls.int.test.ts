/**
 * Intercompany (1000 + 1002) on top of 999r (row security for the company-group tables): the group tables are the root of the
 * trust model (a group connection lives while its companies share a group), so what a session can do to them matters here.
 * Probed as app_user, as withAuth opens a session. A stranger or a viewer cannot deactivate, delete or leave a group, or join one
 * unilaterally; a legitimate writer of the group still can, and doing so revokes the connection and releases its sides.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, party, plantConnection, plantSide, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query('UPDATE company_groups SET is_active = true WHERE id = ANY($1)', [[co.G, co.H]]);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id <> $2', [co.H, co.C]);
  id = await plantConnection(pool, co.A, co.B);
  await plantSide(pool, id, co.B, co.A, { supplier_id: party.bSupplier, auto_accept: true }, U.b);
});

const connection = async () => (await pool.query('SELECT status, revoked_by FROM intercompany_connections WHERE id = $1', [id])).rows[0];
const side = async () => (await pool.query('SELECT supplier_id, auto_accept FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, co.B])).rows[0];
const ACTIVE = { status: 'active', revoked_by: null };
const untouched = async () => {
  expect(await connection()).toEqual(ACTIVE);
  expect(await side()).toEqual({ supplier_id: party.bSupplier, auto_accept: true });
};

/** Rows an UPDATE / DELETE / SELECT touched, or the SQLSTATE of the refusal. `user` null = app_user with no claims at all. Committed. */
async function rows(user: string | null, company: string, text: string, params: unknown[] = []): Promise<string> {
  const body = async (q: PoolClient) => {
    await q.query('SAVEPOINT p');
    try {
      const r = await q.query(text, params);
      await q.query('RELEASE SAVEPOINT p');
      return `rows:${r.rowCount}`;
    } catch (err) {
      await q.query('ROLLBACK TO SAVEPOINT p');
      return `${(err as { code?: string }).code}`;
    }
  };
  if (user) return asAppUser(pool, user, company, body, true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    const out = await body(client);
    await client.query('COMMIT');
    return out;
  } finally {
    client.release();
  }
}

describe('a tenant that is no party cannot end a connection through the group tables (company_groups)', () => {
  it('a viewer or owner of an unrelated company, and a session without claims: no group is visible, none can be deactivated, none deleted', async () => {
    for (const [user, company] of [[U.x, co.C], [U.c, co.C], [U.vc, co.C], [null, co.C]] as const) {
      expect(await rows(user, company, 'SELECT id FROM company_groups WHERE id = $1', [co.G]), `${user}: read`).toBe('rows:0');
      expect(await rows(user, company, 'UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]), `${user}: deactivate`).toBe('rows:0');
      expect(await rows(user, company, 'DELETE FROM company_groups WHERE id = $1', [co.G]), `${user}: delete`).toMatch(/^(rows:0|42501)$/);
    }
    expect((await pool.query('SELECT is_active FROM company_groups WHERE id = $1', [co.G])).rows[0].is_active).toBe(true);
    await untouched();
  });

  it('nobody with app_user rights deletes a group, whatever the role (the app deactivates)', async () => {
    expect(await rows(U.a, co.A, 'DELETE FROM company_groups WHERE id = $1', [co.G])).toMatch(/^(rows:0|42501)$/);
    expect((await pool.query('SELECT 1 FROM company_groups WHERE id = $1', [co.G])).rowCount).toBe(1);
    await untouched();
  });

  it('a viewer of a member company cannot deactivate it either', async () => {
    expect(await rows(U.va, co.A, 'UPDATE company_groups SET is_active = false WHERE id = $1', [co.G])).toMatch(/^(rows:0|42501)$/);
    await untouched();
  });
});

describe('a party cannot make membership true on its own (company_group_members insert)', () => {
  it.each([['an owner of A', U.a], ['a viewer of A', U.va]])('%s cannot add A to a group it has no standing in (H, held by C)', async (_who, user) => {
    expect(await rows(user, co.A, 'INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2)', [co.H, co.A])).toBe('42501');
    expect((await pool.query('SELECT 1 FROM company_group_members WHERE group_id = $1 AND company_id = $2', [co.H, co.A])).rowCount).toBe(0);
  });

  it("so a partner's leave still ends the connection: A cannot have joined another group with B in it", async () => {
    await rows(U.a, co.A, 'INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2)', [co.H, co.A]);
    expect(await rows(U.b, co.B, 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B])).toBe('rows:1');
    expect(await connection()).toEqual({ status: 'revoked', revoked_by: 'system:group-membership' });
  });
});

describe('a viewer cannot write through the group tables (company_group_members update)', () => {
  it('a viewer of A cannot leave A from the group (so cannot revoke the connection or wipe the partner side)', async () => {
    expect(await rows(U.va, co.A, 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE company_id = $1', [co.A])).toMatch(/^(rows:0|42501)$/);
    await untouched();
  });

  it('the viewer who is an owner of the OTHER member company (A owner, B viewer) cannot leave B', async () => {
    expect(await rows(U.avb, co.B, 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE company_id = $1', [co.B])).toMatch(/^(rows:0|42501)$/);
    await untouched();
  });
});

describe('a legitimate writer of the group still ends its connections', () => {
  it('deactivating the group (a writer of a member company) revokes the connection by the system and releases the partner side', async () => {
    expect(await rows(U.a, co.A, 'UPDATE company_groups SET is_active = false WHERE id = $1', [co.G])).toBe('rows:1');
    expect(await connection()).toEqual({ status: 'revoked', revoked_by: 'system:group-membership' });
    expect(await side()).toEqual({ supplier_id: null, auto_accept: false });
  });

  it('a writer of the member company leaving revokes it too', async () => {
    expect(await rows(U.b, co.B, 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B])).toBe('rows:1');
    expect(await connection()).toEqual({ status: 'revoked', revoked_by: 'system:group-membership' });
  });
});
