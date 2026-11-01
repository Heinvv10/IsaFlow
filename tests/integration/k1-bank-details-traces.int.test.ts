/**
 * Wave 3 K1, what a request leaves behind through the real route, withAuth and Postgres: the request log never holds
 * an account number, and a full number read is on the audit log in the same transaction, as a reveal is (Hein's
 * decision 2, entityChangeReveal.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import duplicates from '../../pages/api/payroll/duplicates';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { employee, get, OTHER, put, ROW, rowsOf } from './k1-employee-bank-details.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '';

beforeAll(async () => { [o, a, m] = await members(pool, tokens, 3); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = $1', [o]);
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [companies]);
  await cleanupEntityChanges(pool, companies, [o, a, m]);
});

const company = () => newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager']], companies);

describe('the request log (journald: what the logger writes to stdout)', () => {
  it('a PUT is logged with its body, and the account number is not in it, on success or on a refusal', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const written: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    }
    try {
      expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
      expect((await put(tokens[m]!, c, e, OTHER)).state.statusCode).toBe(403);
      expect((await put(tokens[o]!, c, e, { ...OTHER, bankName: '' })).state.statusCode).toBe(422);
    } finally { vi.restoreAllMocks(); }
    const lines = written.join('');
    expect(lines.match(/API Request: PUT/g)).toHaveLength(3);
    expect(lines).toContain('"accountNumber":"[REDACTED]"');
    expect(lines).not.toContain(ROW.accountNumber);
    expect(lines).not.toContain(OTHER.accountNumber);
  });

  const raw = JSON.stringify(ROW);
  const FORM = 'application/x-www-form-urlencoded';
  const JSON_TYPE = 'application/json';
  // The shapes Next's parser gives these bodies: a string, and the whole text as one key with an empty value.
  it.each([
    ['text/plain', 'text/plain', raw],
    ['a form body holding the JSON as a key', FORM, { [raw]: '' }],
    ['a short form key', FORM, { [`{"accountNumber":"${ROW.accountNumber}"}`]: '' }],
    ['a form-encoded bare number', FORM, { [ROW.accountNumber]: '' }],
    ['a form field with an ordinary name', FORM, { note: ROW.accountNumber }],
    ['a JSON key that is the number', JSON_TYPE, { ...ROW, accountNumber: undefined, [ROW.accountNumber]: 'x' }],
    ['a JSON key holding the number', JSON_TYPE, { ...ROW, accountNumber: undefined, [`acct${ROW.accountNumber}`]: 'x' }],
    ['AccountNumber', JSON_TYPE, { ...ROW, accountNumber: undefined, AccountNumber: ROW.accountNumber }],
    ['Account Number', JSON_TYPE, { ...ROW, accountNumber: undefined, 'Account Number': ROW.accountNumber }],
    ['account.number', JSON_TYPE, { ...ROW, accountNumber: undefined, 'account.number': ROW.accountNumber }],
    ['account no', JSON_TYPE, { ...ROW, accountNumber: undefined, 'account no': ROW.accountNumber }],
    ['account_no', JSON_TYPE, { ...ROW, accountNumber: undefined, account_no: ROW.accountNumber }],
  ])('a PUT carrying the number as %s is refused 422 and the number is not logged', async (_name, contentType, body) => {
    const c = await company();
    const e = await employee(pool, c);
    const written: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    }
    let status = 0;
    try { status = (await put(tokens[o]!, c, e, body, contentType)).state.statusCode; } finally { vi.restoreAllMocks(); }
    expect(status).toBe(422);
    const lines = written.join('');
    expect(lines).toContain('API Request: PUT');
    expect(lines).not.toContain(ROW.accountNumber);
  });
});

describe('the audit log: every full number read, and only those', () => {
  interface Audit { user_id: string; action: string; entity_type: string; entity_id: string; entity_ref: string | null; changes: { metadata?: Record<string, string> } }
  const audits = async (c: string) => (await pool.query<Audit>(
    `SELECT user_id, action, entity_type, entity_id, entity_ref, changes FROM audit_log
     WHERE company_id = $1 AND entity_type LIKE 'payroll_bank%' ORDER BY created_at`, [c])).rows;
  const entered = async () => {
    const c = await company();
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    return { c, e, row: (await rowsOf(pool, e))[0]! };
  };
  const twins = async () => {
    const c = await company();
    const e = [await employee(pool, c), await employee(pool, c)];
    for (const id of e) expect((await put(tokens[o]!, c, id, ROW)).state.statusCode).toBe(200);
    return { c, e };
  };
  const readDuplicates = (token: string, c: string) => callRoute(duplicates, token, c, 'GET', undefined, '/api/payroll/duplicates');

  it.each([['an owner', () => o], ['an admin', () => a]])('%s reading the details leaves one row per read, naming the row and not the number', async (_name, user) => {
    const { c, e, row } = await entered();
    expect(dataOf<{ masked: boolean }>(await get(tokens[user()]!, c, e)).masked).toBe(false);
    await get(tokens[user()]!, c, e);
    const rows = await audits(c);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ user_id: user(), action: 'export', entity_type: 'payroll_bank_detail', entity_id: row.id });
    expect(rows[0]!.changes.metadata).toEqual({ revealed: 'account_number', employeeId: e });
    expect(JSON.stringify(rows)).not.toContain(ROW.accountNumber);
  });

  it('a manager\'s masked read leaves none, nor does an employee with no details', async () => {
    const { c, e } = await entered();
    expect(dataOf<{ masked: boolean }>(await get(tokens[m]!, c, e)).masked).toBe(true);
    expect(dataOf(await get(tokens[o]!, c, await employee(pool, c)))).toBeNull();
    expect(await audits(c)).toEqual([]);
  });

  it('an entry or a change leaves none: the writer sent the number', async () => {
    const { c, e } = await entered();
    expect((await put(tokens[o]!, c, e, OTHER)).state.statusCode).toBe(200);
    expect(await audits(c)).toEqual([]);
  });

  it('an owner\'s duplicates read leaves one row, naming the employees and not the numbers', async () => {
    const { c, e } = await twins();
    expect(JSON.stringify((await readDuplicates(tokens[o]!, c)).state.body)).toContain(ROW.accountNumber);
    const rows = await audits(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: o, action: 'export', entity_type: 'payroll_bank_duplicates', entity_id: c });
    const { employeeIds, ...rest } = rows[0]!.changes.metadata!;
    expect(rest).toEqual({ revealed: 'account_number', groups: '1' });
    expect(employeeIds!.split(',').sort()).toEqual([...e].sort());
    expect(JSON.stringify(rows)).not.toContain(ROW.accountNumber);
  });

  it('a duplicates read that showed no full number leaves none', async () => {
    const { c } = await twins();
    expect(JSON.stringify((await readDuplicates(tokens[m]!, c)).state.body)).not.toContain(ROW.accountNumber);
    const loginAs = await readDuplicates(await impersonationToken(pool, o, m), c);
    expect(loginAs.state.statusCode, JSON.stringify(loginAs.state.body)).toBe(200);
    expect(await audits(c)).toEqual([]);
    const empty = await company();
    expect((await readDuplicates(tokens[o]!, empty)).state.statusCode).toBe(200);
    expect(await audits(empty)).toEqual([]);
  });

  it('no record, no number: an audit write that fails answers 500 with neither route showing it', async () => {
    const { c, e } = await entered();
    const other = await employee(pool, c);
    expect((await put(tokens[o]!, c, other, ROW)).state.statusCode).toBe(200);
    await pool.query(`CREATE OR REPLACE FUNCTION public.k1_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$`);
    await pool.query(`CREATE TRIGGER k1_refuse_audit BEFORE INSERT ON audit_log FOR EACH ROW
      WHEN (NEW.company_id = '${c}'::uuid) EXECUTE FUNCTION public.k1_refuse_audit()`);
    try {
      for (const res of [await get(tokens[o]!, c, e), await readDuplicates(tokens[o]!, c)]) {
        expect(res.state.statusCode).toBe(500);
        expect(JSON.stringify(res.state.body)).not.toContain(ROW.accountNumber);
      }
    } finally {
      await pool.query('DROP TRIGGER k1_refuse_audit ON audit_log');
      await pool.query('DROP FUNCTION public.k1_refuse_audit()');
    }
  });
});
