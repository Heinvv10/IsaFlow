/**
 * Wave 3 K1, an employee's bank-details history beyond the route suite (k1-employee-bank-details): a manager's MCP
 * entity_history masks the account number, branch code and holder, and the reveal of such a change is refused to
 * Login-as and to a token, with nothing on the audit log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import entityChangesReveal from '../../pages/api/accounting/entity-changes-reveal';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, reasonOf } from './r035-approval.helpers';
import { impersonationToken } from './r035-pr2.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { mcpCall } from './entity-changes-mcp.helpers';
import { employee, put, ROW, rowsOf } from './k1-employee-bank-details.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '';

beforeAll(async () => { [o, a, m] = await members(pool, tokens, 3); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [[o, a, m]]);
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [companies]);
  await cleanupEntityChanges(pool, companies, [o, a, m]);
});

/** A company with one employee whose details the owner entered; the id of that create in the history. */
async function entered(): Promise<{ c: string; rowId: string; changeId: string }> {
  const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager']], companies);
  const e = await employee(pool, c);
  const res = await put(tokens[o]!, c, e, ROW);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  const [row] = await rowsOf(pool, e);
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM entity_changes WHERE company_id = $1 AND entity_type = 'payroll_bank_detail' AND entity_id = $2",
    [c, row!.id]);
  expect(rows).toHaveLength(1);
  return { c, rowId: row!.id, changeId: rows[0]!.id };
}

describe('MCP entity_history for a manager', () => {
  it('masks the account number, branch code and holder of a bank-details change', async () => {
    const { c, rowId } = await entered();
    const out = await mcpCall(pool, m, c, 'manager', 'entity_history',
      { entity_type: 'payroll_bank_detail', entity_id: rowId }, ['read:reports', 'read:payroll']);
    expect(out.isError, out.content[0]!.text).toBeFalsy();
    const text = out.content[0]!.text;
    for (const masked of ['…3456', '…55', 'K…']) expect(text).toContain(masked);
    for (const value of [ROW.accountNumber, ROW.branchCode, ROW.accountHolder]) expect(text).not.toContain(value);
  });
});

describe('the reveal of a bank-details change', () => {
  const reveal = (token: string, c: string, changeId: string) =>
    callRoute(entityChangesReveal, token, c, 'POST', { changeId }, '/api/accounting/entity-changes-reveal');
  const audits = async (c: string) => (await pool.query(
    "SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'entity_change'", [c])).rows[0].n as number;

  it.each([
    ['Login-as of the owner', 'IMPERSONATION_FORBIDDEN', () => impersonationToken(pool, o, a)],
    ['a token channel (claims without a session id)', 'AGENT_FORBIDDEN', () => new SignJWT({ sub: o, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET))],
  ])('is refused to %s, and nothing is revealed or recorded', async (_name, reason, token) => {
    const { c, changeId } = await entered();
    const res = await reveal(await token(), c, changeId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(403);
    expect(reasonOf(res)).toBe(reason);
    for (const value of [ROW.accountNumber, ROW.branchCode, ROW.accountHolder]) expect(JSON.stringify(res.state.body)).not.toContain(value);
    expect(await audits(c)).toBe(0);
    // Control: the owner in their own session may reveal it, and that is recorded.
    expect((await reveal(tokens[o]!, c, changeId)).state.statusCode).toBe(200);
    expect(await audits(c)).toBe(1);
  });
});
