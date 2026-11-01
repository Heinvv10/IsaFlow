/**
 * Wave 3 K1, what a request leaves behind through the real route, withAuth and Postgres: the request log never holds
 * an account number.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { employee, OTHER, put, ROW } from './k1-employee-bank-details.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', m = '';

beforeAll(async () => { [o, m] = await members(pool, tokens, 2); });
afterAll(() => cleanupEntityChanges(pool, companies, [o, m]));

const company = () => newCompany(pool, [[o, 'owner'], [m, 'manager']], companies);

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
