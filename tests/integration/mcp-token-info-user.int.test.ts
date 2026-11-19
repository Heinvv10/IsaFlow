/**
 * token_info's `user` against a real database, through the real MCP registry in a request
 * transaction opened as the bearer pipeline opens one (app_user, the token user's claims, the
 * company): the token user is read as a member of the token's company (company_member_directory,
 * a SECURITY DEFINER that answers only for the caller's own company), so a connector can show who
 * it is connected as. A member with no name set answers name null. A second company's member is
 * never the answer. Synthetic rows only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { body, mcp } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = budgetGridFixture(pool);
let A: GridCo;
let B: GridCo;

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  await pool.query(`UPDATE users SET first_name = 'Lew', last_name = 'Smith' WHERE id = $1`, [A.owner.userId]);
}, 60000);

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 60000);

describe('token_info user, as app_user through the MCP registry', () => {
  it('the token user: id, email and full name from this company\'s member directory', async () => {
    const out = body(await mcp(pool, A.owner, 'token_info', {}, { scopes: ['read:reports'] }));
    expect(out.user).toEqual({ id: A.owner.userId, email: `${A.owner.userId}@test.local`, name: 'Lew Smith' });
    expect((out.company as { id: string }).id).toBe(A.id);
  }, 60000);

  it('a member with no name set: name null, email still read; never another company\'s member', async () => {
    const out = body(await mcp(pool, B.viewer, 'token_info', {}, { scopes: ['read:reports'], role: 'viewer' }));
    expect(out.user).toEqual({ id: B.viewer.userId, email: `${B.viewer.userId}@test.local`, name: null });
    expect(JSON.stringify(out)).not.toContain(A.owner.userId);
  }, 60000);
});
