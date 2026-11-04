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
let o = '', a = '', m = '';

beforeAll(async () => { [o, a, m] = await members(pool, tokens, 3); });
afterAll(async () => {
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [companies]);
  await cleanupEntityChanges(pool, companies, [o, a, m]);
});

const masked = (user: string, c: string, e: string, view?: string) =>
  callRoute(bankDetails, tokens[user]!, c, 'GET', undefined, url(e), view ? { id: e, view } : { id: e });
/** The full-read audit rows (what auditBankDetailsRead writes), for the detail row `id`. */
const exportAudits = async (c: string, id: string) => (await pool.query(
  `SELECT 1 FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_bank_detail' AND action = 'export' AND entity_id = $2`,
  [c, id])).rowCount;

describe('GET ?view=masked', () => {
  it.each(['owner', 'admin'])('answers %s masked and leaves no audit row; without it the read is full and audited', async (role) => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const user = role === 'owner' ? o : a;
    const [{ id }] = (await pool.query<{ id: string }>('SELECT id FROM payroll_bank_details WHERE employee_id = $1', [e])).rows as [{ id: string }];

    const res = await masked(user, c, e, 'masked');
    expect(dataOf(res)).toMatchObject({ accountNumber: '…3456', masked: true, branchCode: '…55', accountHolder: 'K…' });
    for (const leak of [ROW.accountNumber, ROW.branchCode, ROW.accountHolder]) expect(JSON.stringify(res.state.body)).not.toContain(leak);
    expect(await exportAudits(c, id)).toBe(0); // before the plain read, after the masked one

    expect(dataOf(await masked(user, c, e))).toMatchObject({ accountNumber: ROW.accountNumber, masked: false });
    expect(await exportAudits(c, id)).toBe(1);
    await masked(user, c, e, 'masked');
    expect(await exportAudits(c, id)).toBe(1); // a second masked read adds none
  });

  it('a manager gets the same masked view, and no audit row, with or without it', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const [{ id }] = (await pool.query<{ id: string }>('SELECT id FROM payroll_bank_details WHERE employee_id = $1', [e])).rows as [{ id: string }];
    for (const view of ['masked', undefined]) {
      expect(dataOf(await masked(m, c, e, view))).toMatchObject({ accountNumber: '…3456', masked: true, branchCode: '…55', accountHolder: 'K…' });
      expect(await exportAudits(c, id)).toBe(0);
    }
  });

  it('any other view value is the ordinary read', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    expect(dataOf(await masked(o, c, e, 'full'))).toMatchObject({ accountNumber: ROW.accountNumber, masked: false });
  });
});
