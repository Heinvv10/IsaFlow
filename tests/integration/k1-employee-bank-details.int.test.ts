/**
 * Wave 3 K1, employee bank details through the real route, withAuth and Postgres, as app_user:
 * first entry by owner / admin / manager, a change by owner / admin only, one active row, the history, masking,
 * human sessions only, a refusal that writes nothing. Tenancy, the migration and what a request leaves behind have their
 * own suites (k1-bank-details-tenancy, k1-bank-details-migration, k1-bank-details-traces).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import entityChanges from '../../pages/api/accounting/entity-changes';
import { todayInSast } from '../../src/lib/saDateParser';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, reasonOf } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { changesOf, cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { mcpCall } from './entity-changes-mcp.helpers';
import { employee, get, OTHER, put, ROW, rowsOf } from './k1-employee-bank-details.helpers';
import type { EntityChangePage } from '../../src/modules/accounting/services/core/entityChanges/entityChangeTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '', v = '';

beforeAll(async () => { [o, a, m, v] = await members(pool, tokens, 4); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [[o, a, m, v]]);
  await cleanupEntityChanges(pool, companies, [o, a, m, v]);
});

const company = () => newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer']], companies);
const history = (user: string, c: string, query: Record<string, string>) =>
  callRoute(entityChanges, tokens[user]!, c, 'GET', undefined, '/api/accounting/entity-changes', query);
type View = { id: string; accountNumber: string; masked: boolean; bankName: string; accountHolder: string | null; effectiveFrom: string };
const view = (res: Awaited<ReturnType<typeof put>>) => dataOf<View>(res);

async function entered(): Promise<{ c: string; e: string }> {
  const c = await company();
  const e = await employee(pool, c);
  const res = await put(tokens[o]!, c, e, ROW);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return { c, e };
}

describe('the first entry', () => {
  it.each(['owner', 'admin', 'manager'])('a %s may make it', async (role) => {
    const c = await company();
    const e = await employee(pool, c);
    const user = { owner: o, admin: a, manager: m }[role]!;
    const res = await put(tokens[user]!, c, e, ROW);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const [row] = await rowsOf(pool, e);
    expect(row).toMatchObject({ company_id: c, is_active: true, account_number: ROW.accountNumber, effective_from: todayInSast() });
  });

  it('answers the manager masked, and GET masks for a manager but not for owner or admin', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const res = await put(tokens[m]!, c, e, ROW);
    expect(view(res)).toMatchObject({ accountNumber: '…3456', masked: true, bankName: 'FNB', accountHolder: 'K One' });
    expect(JSON.stringify(res.state.body)).not.toContain(ROW.accountNumber);
    const read = await get(tokens[m]!, c, e);
    expect(view(read)).toMatchObject({ accountNumber: '…3456', masked: true, effectiveFrom: todayInSast() });
    expect(JSON.stringify(read.state.body)).not.toContain(ROW.accountNumber);
    for (const user of [o, a]) expect(view(await get(tokens[user]!, c, e))).toMatchObject({ accountNumber: ROW.accountNumber, masked: false });
  });

  it('an employee with no details answers null, not a 404', async () => {
    const c = await company();
    const res = await get(tokens[m]!, c, await employee(pool, c));
    expect(res.state.statusCode).toBe(200);
    expect(dataOf(res)).toBeNull();
  });

  it('two managers racing: one first entry lands, the other is a change and is refused', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const [m2] = await members(pool, tokens, 1);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'manager')", [c, m2]);
    const out = await Promise.all([put(tokens[m]!, c, e, ROW), put(tokens[m2!]!, c, e, OTHER)]);
    expect(out.map((r) => r.state.statusCode).sort()).toEqual([200, 403]);
    expect(await rowsOf(pool, e)).toHaveLength(1);
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [m2]);
    await pool.query('DELETE FROM users WHERE id = $1', [m2]);
  });
});

describe('the first entry waits for the employee lock', () => {
  it('a manager arriving behind an uncommitted entry waits, then sees a change and is refused', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const peer = await pool.connect();
    try {
      await peer.query('BEGIN');
      await peer.query('SELECT 1 FROM payroll_employees WHERE id = $1 FOR UPDATE', [e]);
      await peer.query(
        `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, branch_code, is_active)
         VALUES ($1, $2, 'Peer', '555555555', '250655', false)`, [c, e]);
      const arriving = put(tokens[m]!, c, e, ROW);
      await vi.waitFor(async () => {
        const { rows } = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM payroll_employees%FOR UPDATE%'");
        expect(rows).toHaveLength(1);
      }, { timeout: 3000, interval: 25 });
      await peer.query('COMMIT');
      expect((await arriving).state.statusCode).toBe(403);
      expect(await rowsOf(pool, e)).toHaveLength(1);
    } finally {
      await peer.query('ROLLBACK');
      peer.release();
    }
  });
});

describe('a change to existing details', () => {
  it('owner and admin: one active row, the old one kept inactive, one create in the new row\'s history', async () => {
    const { c, e } = await entered();
    const res = await put(tokens[a]!, c, e, OTHER);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const rows = await rowsOf(pool, e);
    expect(rows.map((r) => [r.is_active, r.account_number]).sort()).toEqual([[false, ROW.accountNumber], [true, OTHER.accountNumber]]);
    const fresh = rows.find((r) => r.is_active)!;
    expect(view(res).id).toBe(fresh.id);
    expect((await changesOf(pool, fresh.id)).map((x) => [x.entity_type, x.op, x.actor, x.channel]))
      .toEqual([['payroll_bank_detail', 'create', a, 'session']]);
    const old = rows.find((r) => !r.is_active)!;
    expect((await changesOf(pool, old.id)).map((x) => [x.op, x.changed])).toEqual([['create', expect.any(Array)], ['update', ['is_active']]]);
  });

  it('a manager reads that history with the account masked; a viewer may not read it at all', async () => {
    const { c, e } = await entered();
    await put(tokens[o]!, c, e, OTHER);
    const fresh = (await rowsOf(pool, e)).find((r) => r.is_active)!;
    const query = { entityType: 'payroll_bank_detail', entityId: fresh.id };
    const res = await history(m, c, query);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { items } = dataOf<EntityChangePage>(res);
    expect(items).toHaveLength(1);
    expect(items[0]!.fields.find((f) => f.key === 'account_number')).toEqual({ key: 'account_number', before: null, after: '…4680', masked: true });
    expect(JSON.stringify(items)).not.toContain(OTHER.accountNumber);
    expect((await history(v, c, query)).state.statusCode).toBe(403);
  });

  it('a manager is refused 403 and nothing is written', async () => {
    const { c, e } = await entered();
    const before = await rowsOf(pool, e);
    const res = await put(tokens[m]!, c, e, OTHER);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('CHANGE_REQUIRES_ADMIN'); // K2's form branches on this
    expect((res.state.body as { error?: { message?: string } }).error?.message).toBe('Only an owner or admin can change existing bank details.');
    expect(await rowsOf(pool, e)).toEqual(before);
    expect((await changesOf(pool, before[0]!.id)).map((x) => x.op)).toEqual(['create']);
  });

  it('a manager cannot pass off re-entry as a first entry once a row was retired', async () => {
    const { c, e } = await entered();
    await pool.query('UPDATE payroll_bank_details SET is_active = false WHERE employee_id = $1', [e]);
    const res = await put(tokens[m]!, c, e, OTHER);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('CHANGE_REQUIRES_ADMIN');
    expect(await rowsOf(pool, e)).toHaveLength(1);
  });

  it('a refused validation (blank bank name) leaves the row active and writes nothing', async () => {
    const { c, e } = await entered();
    const before = await rowsOf(pool, e);
    const res = await put(tokens[o]!, c, e, { ...OTHER, bankName: '  ' });
    expect(res.state.statusCode).toBe(422);
    expect(await rowsOf(pool, e)).toEqual(before);
    expect((await changesOf(pool, before[0]!.id)).map((x) => x.op)).toEqual(['create']);
  });
});

describe('the same details sent again', () => {
  it('changes nothing: the same row back, no new row, nothing in the history', async () => {
    const { c, e } = await entered();
    const [before] = await rowsOf(pool, e);
    const res = await put(tokens[o]!, c, e, { ...ROW, accountNumber: ' 6200 0123 456 ', bankName: ' FNB ' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(view(res)).toMatchObject({ id: before!.id, accountNumber: ROW.accountNumber, masked: false });
    expect(await rowsOf(pool, e)).toEqual([before]);
    expect((await changesOf(pool, before!.id)).map((x) => x.op)).toEqual(['create']);
  });

  it.each([
    ['bank name', { bankName: 'First National Bank' }], ['branch code', { branchCode: '250656' }],
    ['account number', { accountNumber: '62000123457' }], ['account type', { accountType: 'savings' }],
    ['holder', { accountHolder: 'K Two' }], ['holder removed', { accountHolder: null }],
  ])('a different %s is a change', async (_name, change) => {
    const { c, e } = await entered();
    expect((await put(tokens[o]!, c, e, { ...ROW, ...change })).state.statusCode).toBe(200);
    expect(await rowsOf(pool, e)).toHaveLength(2);
  });

  it('the same details on a retired row are a new entry: there is nothing active to leave alone', async () => {
    const { c, e } = await entered();
    await pool.query('UPDATE payroll_bank_details SET is_active = false WHERE employee_id = $1', [e]);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    expect((await rowsOf(pool, e)).map((r) => r.is_active).sort()).toEqual([false, true]);
  });

  it('is still refused to a manager: 200 against 403 would confirm a guessed account number', async () => {
    const { c, e } = await entered();
    const res = await put(tokens[m]!, c, e, ROW);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('CHANGE_REQUIRES_ADMIN');
  });
});

describe('who may reach the route', () => {
  it('a viewer is refused both ways', async () => {
    const { c, e } = await entered();
    expect((await get(tokens[v]!, c, e)).state.statusCode).toBe(403);
    expect((await put(tokens[v]!, c, e, OTHER)).state.statusCode).toBe(403);
  });

  it('Login-as is refused both ways, even as the owner, and writes nothing', async () => {
    const { c, e } = await entered();
    const before = await rowsOf(pool, e);
    const token = await impersonationToken(pool, o, a);
    for (const res of [await get(token, c, e), await put(token, c, e, OTHER)]) {
      expect(res.state.statusCode).toBe(403);
      expect(reasonOf(res)).toBe('IMPERSONATION_FORBIDDEN');
    }
    expect(await rowsOf(pool, e)).toEqual(before);
  });

  it('a token channel (claims without a session id) is refused both ways', async () => {
    const { c, e } = await entered();
    const token = await new SignJWT({ sub: o, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    for (const res of [await get(token, c, e), await put(token, c, e, OTHER)]) {
      expect(res.state.statusCode).toBe(403);
      expect(reasonOf(res)).toBe('AGENT_FORBIDDEN');
    }
  });

  it('MCP entity_history: masked, and only with read:payroll', async () => {
    const { c, e } = await entered();
    const [row] = await rowsOf(pool, e);
    const args = { entity_type: 'payroll_bank_detail', entity_id: row!.id };
    const without = await mcpCall(pool, o, c, 'owner', 'entity_history', args, ['read:reports']);
    expect(without.isError).toBe(true);
    const out = await mcpCall(pool, o, c, 'owner', 'entity_history', args, ['read:reports', 'read:payroll']);
    expect(out.isError, out.content[0]!.text).toBeFalsy();
    expect(out.content[0]!.text).toContain('…3456');
    expect(out.content[0]!.text).not.toContain(ROW.accountNumber);
  });
});
