/**
 * setUpSignupBureau: the bureau an Accountant sign-up gets at verification.
 * Runs on verify-email's open transaction, so the properties pinned here are:
 *   - one SAVEPOINT around every write, released on success
 *   - the insert is authorised in the statement (the company owner row) and
 *     its ids are bound as parameters, never interpolated
 *   - a replay finds the existing bureau and writes no second audit row
 *   - a database error rolls back to the savepoint and never escapes; any
 *     other error does
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() } }));

import { setUpSignupBureau } from '@/modules/bureau/services/signupBureauService';

type Call = { text: string; values: unknown[] };
type Responder = (text: string, values: unknown[]) => { rows: Array<Record<string, unknown>> } | Error;

function fakeClient(respond: Responder) {
  const calls: Call[] = [];
  return {
    calls,
    first: () => calls.map((c) => c.text.trim().split('\n')[0]!.trim()),
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const out = respond(text, values);
      if (out instanceof Error) throw out;
      return out;
    }) as never,
  };
}

const INPUT = { ownerUserId: 'user-1', ownerEmail: 'a@b.co.za', companyId: 'company-1', practiceName: '  Smith Practice  ' };
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const happy: Responder = (text) => (/^INSERT INTO bureaus/.test(text.trim()) ? { rows: [{ id: 'bureau-1' }] } : { rows: [] });

beforeEach(() => vi.clearAllMocks());

describe('setUpSignupBureau: created', () => {
  it('writes in one savepoint, in order, and releases it', async () => {
    const c = fakeClient(happy);
    expect(await setUpSignupBureau(c, INPUT)).toEqual({ status: 'created', bureauId: 'bureau-1' });
    expect(c.first()).toEqual([
      'SAVEPOINT signup_bureau',
      'INSERT INTO bureaus (name, owner_user_id, created_via)',
      "INSERT INTO bureau_users (bureau_id, user_id, role) VALUES ($1::uuid, $2, 'owner')",
      "UPDATE users SET account_type = 'bureau_owner' WHERE id = $1 AND account_type = 'direct'",
      'INSERT INTO audit_log (',
      'RELEASE SAVEPOINT signup_bureau',
    ]);
  });

  it('authorises the insert on the company owner row and binds the ids', async () => {
    const c = fakeClient(happy);
    await setUpSignupBureau(c, INPUT);
    const ins = c.calls[1]!;
    expect(ins.text).toMatch(/FROM company_users cu\s+WHERE cu\.company_id = \$2::uuid AND cu\.user_id = \$1 AND cu\.role = 'owner'/);
    expect(ins.text).toMatch(/ON CONFLICT \(owner_user_id\) WHERE created_via = 'signup_auto' DO NOTHING/);
    expect(ins.values).toEqual(['user-1', 'company-1', 'Smith Practice']);
    expect(ins.text).not.toContain('user-1');
    expect(ins.text).not.toContain('company-1');
  });

  it('never links a company to the bureau', async () => {
    const c = fakeClient(happy);
    await setUpSignupBureau(c, INPUT);
    expect(c.calls.some((x) => /bureau_companies/.test(x.text))).toBe(false);
  });

  it('writes the audit row: who, which company, the bureau, source signup_auto', async () => {
    const c = fakeClient(happy);
    await setUpSignupBureau(c, INPUT);
    const audit = c.calls.find((x) => /^INSERT INTO audit_log/.test(x.text.trim()))!;
    expect(audit.text).toContain("'create'");
    expect(audit.text).toContain("'bureau'");
    const [company, user, email, entity, ref, meta] = audit.values as string[];
    expect([company, user, email, entity, ref]).toEqual(['company-1', 'user-1', 'a@b.co.za', 'bureau-1', 'Smith Practice']);
    expect(JSON.parse(meta!)).toEqual({ source: 'signup_auto', bureau_id: 'bureau-1', company_id: 'company-1', signup_type: 'accountant' });
  });

  it('caps the name at 200 and the audit entity_ref at 100', async () => {
    const c = fakeClient(happy);
    await setUpSignupBureau(c, { ...INPUT, practiceName: ` ${'x'.repeat(250)} ` });
    expect((c.calls[1]!.values[2] as string).length).toBe(200);
    const audit = c.calls.find((x) => /^INSERT INTO audit_log/.test(x.text.trim()))!;
    expect((audit.values[4] as string).length).toBe(100);
  });
});

describe('setUpSignupBureau: replay and refusal', () => {
  it('a replay finds the existing bureau and writes no audit row', async () => {
    const c = fakeClient((text) => (/^SELECT id FROM bureaus/.test(text.trim()) ? { rows: [{ id: 'bureau-1' }] } : { rows: [] }));
    expect(await setUpSignupBureau(c, INPUT)).toEqual({ status: 'existing', bureauId: 'bureau-1' });
    expect(c.calls.some((x) => /audit_log/.test(x.text))).toBe(false);
    expect(c.first().at(-1)).toBe('RELEASE SAVEPOINT signup_bureau');
  });

  it('the replay lookup carries the same owner predicate as the insert', async () => {
    const c = fakeClient(() => ({ rows: [] }));
    await setUpSignupBureau(c, INPUT);
    const sel = c.calls.find((x) => /^SELECT id FROM bureaus/.test(x.text.trim()))!;
    expect(sel.text).toMatch(/EXISTS \(SELECT 1 FROM company_users cu\s+WHERE cu\.company_id = \$2::uuid AND cu\.user_id = \$1 AND cu\.role = 'owner'\)/);
    expect(sel.values).toEqual(['user-1', 'company-1']);
  });

  it('not the company owner: failed, rolled back to the savepoint, nothing after it', async () => {
    const c = fakeClient(() => ({ rows: [] }));
    expect(await setUpSignupBureau(c, INPUT)).toEqual({ status: 'failed' });
    expect(c.first()).toEqual([
      'SAVEPOINT signup_bureau',
      'INSERT INTO bureaus (name, owner_user_id, created_via)',
      "SELECT id FROM bureaus WHERE owner_user_id = $1 AND created_via = 'signup_auto'",
      'ROLLBACK TO SAVEPOINT signup_bureau',
    ]);
    expect(logError).toHaveBeenCalled();
  });
});

describe('setUpSignupBureau: errors', () => {
  it.each([
    ['INSERT INTO bureaus', '42501'],
    ['INSERT INTO bureau_users', '23503'],
    ['UPDATE users', '42501'],
    ['INSERT INTO audit_log', '23514'],
  ])('a pg error on %s rolls back to the savepoint and returns failed', async (stmt, code) => {
    const c = fakeClient((text, values) => (text.trim().startsWith(stmt) ? pgError(code) : happy(text, values)));
    expect(await setUpSignupBureau(c, INPUT)).toEqual({ status: 'failed' });
    expect(c.first().at(-1)).toBe('ROLLBACK TO SAVEPOINT signup_bureau');
    expect(c.first()).not.toContain('RELEASE SAVEPOINT signup_bureau');
    expect(logError.mock.calls[0]![1]).toMatchObject({ code, companyId: 'company-1', ownerUserId: 'user-1' });
  });

  it('a non-pg error is re-thrown, not swallowed', async () => {
    const c = fakeClient((text, values) => (/^INSERT INTO bureau_users/.test(text.trim()) ? new TypeError('boom') : happy(text, values)));
    await expect(setUpSignupBureau(c, INPUT)).rejects.toThrow('boom');
    expect(c.first()).not.toContain('ROLLBACK TO SAVEPOINT signup_bureau');
  });

  it('a failing ROLLBACK TO SAVEPOINT is re-thrown', async () => {
    const c = fakeClient((text, values) => {
      if (/^INSERT INTO bureaus/.test(text.trim())) return pgError('42501');
      if (/^ROLLBACK TO SAVEPOINT/.test(text.trim())) return pgError('08006');
      return happy(text, values);
    });
    await expect(setUpSignupBureau(c, INPUT)).rejects.toThrow('pg 08006');
  });
});

describe('the sign-up audit row', () => {
  const columnsOf = (file: string): string[] => {
    const m = /INSERT INTO audit_log \(([^)]*)\)/.exec(readFileSync(file, 'utf8'));
    if (!m) throw new Error(`no audit_log INSERT in ${file}`);
    return m[1]!.split(',').map((c) => c.trim()).filter(Boolean);
  };

  it('names exactly the columns logAuditOrThrow inserts, in the same order', () => {
    const general = columnsOf('src/modules/accounting/services/core/auditTrailService.ts');
    expect(general.length).toBeGreaterThan(5);
    expect(columnsOf('src/modules/bureau/services/signupBureauService.ts')).toEqual(general);
  });
});
