/**
 * #678 review H1 / M4 / L1 through the real withAuth chain on a disposable DB.
 * The payroll cost-centre routes write the same rows as the accounting master,
 * so they now refuse what it refuses (cross-tenant parent, loop, carried FNO
 * move, deactivating a parent with active children) as a 400 that names why.
 * A toggle to the state a centre is already in is a 200 again. And the MCP
 * delete tool answers an FK-held delete with its refusal, leaving the request
 * transaction usable for the registry's audit write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import payrollCreate from '../../pages/api/payroll/cost-centres';
import payrollEdit from '../../pages/api/payroll/cost-centres/[id]';
import costCentresAction from '../../pages/api/accounting/cost-centres-action';
import { deleteCostCentreTool } from '@/lib/mcp/tools/dimensionMasterEditTools';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { routeCaller, type Route } from './w3-01-payroll.helpers';
import { costCentre, dropBase, inRequest, journalLine, seedBase, type Base } from './dims-678.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user, company });
let b: Base;
let ob: Base;
let f1 = '';
let f2 = '';
let foreignFno = '';

beforeAll(async () => {
  b = await seedBase(pool, company, user);
  ob = await seedBase(pool, other, user);
  tokens[user] = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  f1 = await costCentre(pool, company, 'R-F1');
  f2 = await costCentre(pool, company, 'R-F2');
  foreignFno = await costCentre(pool, other, 'R-XF');
}, 60000);
afterAll(async () => {
  try { await dropBase(pool, [company, other], [user]); } finally { await pool.end(); }
}, 60000);

const row = async (id: string) => (await pool.query('SELECT parent_id, is_active, cc_type FROM cost_centres WHERE id = $1', [id])).rows[0];
const patch = (id: string, body: unknown) => call(payrollEdit as Route, 'PATCH', `/api/payroll/cost-centres/${id}`, id, { body });

describe('payroll routes go through the master rules (H1)', () => {
  it('POST refuses another tenant\'s parent and writes nothing', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM cost_centres WHERE company_id = $1', [company])).rows[0].n;
    const out = await call(payrollCreate as Route, 'POST', '/api/payroll/cost-centres', undefined,
      { body: { code: 'R-NEW', name: 'New', parentId: foreignFno } });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/does not name an active CC1 or CC2 in this company/);
    expect((await pool.query('SELECT count(*)::int AS n FROM cost_centres WHERE company_id = $1', [company])).rows[0].n).toBe(before);
  });

  it('POST with this company\'s CC1 as parent creates a CC2 under it; without a parent, a CC1', async () => {
    const child = await call(payrollCreate as Route, 'POST', '/api/payroll/cost-centres', undefined,
      { body: { code: 'R-C2', name: 'Child', parentId: f1, notes: 'from payroll' } });
    expect(child.statusCode, JSON.stringify(child.body)).toBe(201);
    expect(child.body.data).toMatchObject({ code: 'R-C2', parentId: f1, notes: 'from payroll', createdBy: user });
    expect(await row(String(child.body.data!.id))).toMatchObject({ cc_type: 'cc2', parent_id: f1 });
    const top = await call(payrollCreate as Route, 'POST', '/api/payroll/cost-centres', undefined, { body: { code: 'R-TOP', name: 'Top' } });
    expect(top.statusCode).toBe(201);
    expect(await row(String(top.body.data!.id))).toMatchObject({ cc_type: 'cc1', parent_id: null });
  });

  it('PATCH refuses another tenant\'s parent', async () => {
    const p = await costCentre(pool, company, 'R-P0', 'cc2', f1);
    const out = await patch(p, { parentId: foreignFno });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/does not name an active CC1 or CC2/);
    expect((await row(p)).parent_id).toBe(f1);
  });

  it('PATCH refuses moving a carried project to another FNO', async () => {
    const p = await costCentre(pool, company, 'R-P1', 'cc2', f1);
    await journalLine(pool, b, 'cc2_id', p);
    const out = await patch(p, { parentId: f2 });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/from FNO R-F1 to R-F2 would leave the CC1 wrong on 1/);
    expect((await row(p)).parent_id).toBe(f1);
  });

  it('PATCH refuses a loop', async () => {
    const prog = await costCentre(pool, company, 'R-PROG', 'cc2', f1);
    const kid = await costCentre(pool, company, 'R-KID', 'cc2', prog);
    const out = await patch(prog, { parentId: kid });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/would make a loop/);
    expect((await row(prog)).parent_id).toBe(f1);
  });

  it('DELETE refuses deactivating a parent with active children; deactivating an inactive one is a 200', async () => {
    const parent = await costCentre(pool, company, 'R-PAR');
    await costCentre(pool, company, 'R-CH', 'cc2', parent);
    const out = await call(payrollEdit as Route, 'DELETE', `/api/payroll/cost-centres/${parent}`, parent);
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/has active children \(R-CH\)/);
    expect((await row(parent)).is_active).toBe(true);
    const idle = await costCentre(pool, company, 'R-IDLE', 'cc1', null, false);
    expect((await call(payrollEdit as Route, 'DELETE', `/api/payroll/cost-centres/${idle}`, idle)).statusCode).toBe(200);
  });
});

describe('payroll PATCH / DELETE on an id that is not this company\'s', () => {
  it.each(['PATCH', 'DELETE'])('%s answers 404 for an unknown id and for another company\'s, and changes nothing', async (method) => {
    const theirs = await costCentre(pool, other, `R-THEIRS-${method}`);
    for (const id of [crypto.randomUUID(), theirs]) {
      const out = await call(payrollEdit as Route, method, `/api/payroll/cost-centres/${id}`, id,
        method === 'PATCH' ? { body: { name: 'Hijacked' } } : {});
      expect(out.statusCode, JSON.stringify(out.body)).toBe(404);
      expect(out.body.error?.message).toBe('Cost centre not found');
    }
    expect((await pool.query('SELECT name, is_active FROM cost_centres WHERE id = $1', [theirs])).rows[0])
      .toEqual({ name: `R-THEIRS-${method}`, is_active: true });
  });
});

describe('accounting action route (M4)', () => {
  it('a toggle to the current state is a 200, not "Nothing to change"', async () => {
    const cc = await costCentre(pool, company, 'R-TOG');
    const out = await call(costCentresAction as Route, 'POST', '/api/accounting/cost-centres-action', undefined,
      { body: { action: 'toggle', id: cc, isActive: true } });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect((await row(cc)).is_active).toBe(true);
  });
});

describe('MCP delete_cost_centre (L1)', () => {
  it('answers an FK-held delete with the refusal and leaves the transaction usable', async () => {
    const cc = await costCentre(pool, company, 'R-MCP');
    await journalLine(pool, ob, 'cc1_id', cc); // another tenant: only the FK sees it
    const ctx = { companyId: company, userId: user, scopes: ['write:accounts'], tokenJti: 'j', oauthAppId: null } as unknown as McpToolContext;
    const out = await inRequest(pool, b, async (c) => ({
      result: await deleteCostCentreTool.handler({ cost_centre: cc, idempotency_key: 'k' }, ctx),
      after: (await c.query('SELECT 1 AS ok')).rows[0].ok,
    }));
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]!.text).toBe('Cannot delete cost centre that is used by other records. Deactivate instead.');
    expect(out.after).toBe(1);
  });
});
