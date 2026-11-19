/**
 * token_info's `user` against a real database, through the real MCP registry in a request
 * transaction opened as the bearer pipeline opens one (app_user, the token user's claims, the
 * company): the token user is read as a member of the token's company (company_member_directory,
 * a SECURITY DEFINER that answers only for the caller's own company), so a connector can show who
 * it is connected as: the token holder's OWN id, email and name, never another member, even for an
 * owner, whom the directory shows every member. A member with no name set answers name null. A
 * second company's member is never the answer. Synthetic rows only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { body, mcp, text } from './helpers/mcpBudgetFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = budgetGridFixture(pool);
let A: GridCo;
let B: GridCo;
/** A second owner of A, made AFTER the fixture's owner and viewer, so a read that lost its user filter answers someone else first. */
let lateOwner: SetupUser;

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  await pool.query(`UPDATE users SET first_name = 'Lew', last_name = 'Smith' WHERE id = $1`, [A.owner.userId]);
  lateOwner = { userId: crypto.randomUUID(), homeCompanyId: A.id, token: '' };
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed, first_name, last_name)
    VALUES ($1, $2, 'admin', true, true, 'Late', 'Owner')`, [lateOwner.userId, `${lateOwner.userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [A.id, lateOwner.userId]);
}, 60000);

afterAll(async () => {
  try {
    await fx.cleanup();
    await pool.query('DELETE FROM users WHERE id = $1', [lateOwner?.userId ?? '']);
  } finally { await pool.end(); }
}, 60000);

describe('token_info user, as app_user through the MCP registry', () => {
  it('the token user: id, email and full name from this company\'s member directory', async () => {
    const out = body(await mcp(pool, A.owner, 'token_info', {}, { scopes: ['read:reports'] }));
    expect(out.user).toEqual({ id: A.owner.userId, email: `${A.owner.userId}@test.local`, name: 'Lew Smith' });
    expect((out.company as { id: string }).id).toBe(A.id);
  }, 60000);

  it('an owner (who can see every member) gets only their OWN id, email and name back', async () => {
    const members = (await pool.query('SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1', [A.id])).rows[0].n;
    expect(members).toBe(3);
    const out = body(await mcp(pool, lateOwner, 'token_info', {}, { scopes: ['read:reports'] }));
    expect(out.user).toEqual({ id: lateOwner.userId, email: `${lateOwner.userId}@test.local`, name: 'Late Owner' });
    const reply = JSON.stringify(out);
    for (const other of [A.owner.userId, A.viewer.userId]) expect(reply).not.toContain(other);
    expect(reply).not.toContain('Lew Smith');
  }, 60000);

  it('a token user who is not a member of the token company: the company read finds nothing, generic not-found', async () => {
    // The bearer pipeline admits members only; this is what the tool itself does if one got through.
    const stranger: SetupUser = { userId: B.owner.userId, homeCompanyId: A.id, token: '' };
    const r = await mcp(pool, stranger, 'token_info', {}, { scopes: ['read:reports'] });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Not found');
  }, 60000);

  it('a member with no name set: name null, email still read; never another company\'s member', async () => {
    const out = body(await mcp(pool, B.viewer, 'token_info', {}, { scopes: ['read:reports'], role: 'viewer' }));
    expect(out.user).toEqual({ id: B.viewer.userId, email: `${B.viewer.userId}@test.local`, name: null });
    expect(JSON.stringify(out)).not.toContain(A.owner.userId);
  }, 60000);
});
