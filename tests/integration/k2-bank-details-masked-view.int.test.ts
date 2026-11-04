/**
 * Wave 3 K2, the profile card's read: GET ?view=masked answers owner / admin the masked view too (so the page never
 * holds a full number it does not show), and writes no `export` audit row, which a full read does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankDetails from '../../pages/api/payroll/employees/[id]/bank-details';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { employee, put, ROW, url } from './k1-employee-bank-details.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '';

beforeAll(async () => { [o, a] = await members(pool, tokens, 2); });
afterAll(async () => {
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [companies]);
  await cleanupEntityChanges(pool, companies, [o, a]);
});

const masked = (user: string, c: string, e: string, view?: string) =>
  callRoute(bankDetails, tokens[user]!, c, 'GET', undefined, url(e), view ? { id: e, view } : { id: e });
const exportAudits = async (c: string) => (await pool.query(
  `SELECT 1 FROM audit_log WHERE company_id = $1 AND entity_type LIKE 'payroll_bank%'`, [c])).rowCount;

describe('GET ?view=masked', () => {
  it.each(['owner', 'admin'])('answers %s masked and leaves no audit row; without it the read is full and audited', async (role) => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const user = role === 'owner' ? o : a;

    const res = await masked(user, c, e, 'masked');
    expect(dataOf(res)).toMatchObject({ accountNumber: '…3456', masked: true, branchCode: '…55', accountHolder: 'K…' });
    for (const leak of [ROW.accountNumber, ROW.branchCode, ROW.accountHolder]) expect(JSON.stringify(res.state.body)).not.toContain(leak);
    expect(await exportAudits(c)).toBe(0);

    expect(dataOf(await masked(user, c, e))).toMatchObject({ accountNumber: ROW.accountNumber, masked: false });
    expect(await exportAudits(c)).toBe(1);
  });

  it('any other view value is the ordinary read', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    expect(dataOf(await masked(o, c, e, 'full'))).toMatchObject({ accountNumber: ROW.accountNumber, masked: false });
  });
});
