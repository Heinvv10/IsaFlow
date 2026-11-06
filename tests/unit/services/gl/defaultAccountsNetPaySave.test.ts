/**
 * The Default Accounts save, `payroll_net_pay` branch (defaultAccountsService#netPayChoice and the stores/others merge)
 * and the audit row of every change, with a mocked transaction. The integration suite covers the same through the route
 * on a real database; this one runs everywhere and pins each refusal and the exact JSON that is stored:
 *   not found -> 400, a rule refusal -> 400, a loan account -> 400, a stale page -> 409 (judged AFTER the account's own
 *   validity), unchanged -> nothing written and nothing audited, cleared -> stored as null (never ''), and the audit
 *   row names who, the old and the new account id and code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const snapshot = { holders: new Map<string, string>(), contested: new Set<string>() };
vi.mock('@/modules/accounting/services/gl/systemRoleInvariant', () => ({
  snapshotRoles: vi.fn(async () => snapshot), rolesNotKept: vi.fn(() => []),
}));
vi.mock('@/modules/accounting/services/gl/systemRoleWriteLock', () => ({
  lockSystemRoleWrites: vi.fn(async () => undefined),
  withBoundedLockWait: async (_tx: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/modules/accounting/services/gl/vatLockLineClassification', () => ({ assertAccountChangesKeepVatLocks: vi.fn(async () => undefined) }));
const logAuditOrThrow = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: (...a: unknown[]) => logAuditOrThrow(...a) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));

import { DefaultAccountsRefusal, saveDefaultAccountMappings } from '@/modules/accounting/services/gl/defaultAccountsService';
import type { TxSql } from '@/lib/neon';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'user-7';
const C2170 = '21700000-0000-4000-8000-000000000001';
const C2171 = '21700000-0000-4000-8000-000000000002';
const ASSET = '11100000-0000-4000-8000-000000000001';
const LOAN = '22150000-0000-4000-8000-000000000001';
const AP_OLD = '21100000-0000-4000-8000-000000000001';
const AP_NEW = '21100000-0000-4000-8000-000000000002';

interface Acct { id: string; code: string; name: string; type: string; subtype: string | null; active?: boolean; kids?: boolean }
const CHART: Acct[] = [
  { id: C2170, code: '2170', name: 'Net Salaries Payable', type: 'liability', subtype: 'payroll_liability' },
  { id: C2171, code: '2171', name: 'Net Salaries Two', type: 'liability', subtype: 'payroll_liability' },
  { id: ASSET, code: '1110', name: 'Bank', type: 'asset', subtype: 'bank' },
  { id: LOAN, code: '2215', name: 'Current Portion', type: 'liability', subtype: 'payroll_liability' },
  { id: AP_OLD, code: '2110', name: 'Accounts Payable', type: 'liability', subtype: 'payable' },
  { id: AP_NEW, code: '2111', name: 'Creditors', type: 'liability', subtype: 'other' },
];

let stored: unknown;
let writes: Array<{ text: string; values: unknown[] }>;
let loanAccounts: Set<string>;
const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?');
  if (text.includes('INSERT INTO app_settings') || text.includes('UPDATE gl_accounts')) {
    writes.push({ text, values });
    return [];
  }
  if (text.includes('FROM app_settings')) return stored === undefined ? [] : [{ value: stored }];
  if (text.includes('FROM loans')) return values[0] === CO && loanAccounts.has(String(values[1])) ? [{ one: 1 }] : [];
  if (text.includes('AS has_children')) {
    const a = CHART.find((c) => c.id === values[0] && values[1] === CO);
    return a ? [{ account_code: a.code, account_type: a.type, account_subtype: a.subtype, is_active: a.active !== false, has_children: a.kids === true }] : [];
  }
  if (text.includes('AS id')) {
    const ids = values.find(Array.isArray) as string[];
    return CHART.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, account_code: c.code, account_name: c.name }));
  }
  return [];
}) as unknown as TxSql;

const save = (mappings: Record<string, unknown>, loaded: Record<string, unknown>) =>
  saveDefaultAccountMappings(tx, CO, mappings, loaded, USER);
const settingWrite = () => writes.filter((w) => w.text.includes('INSERT INTO app_settings'));
const storedJson = (): Record<string, unknown> => JSON.parse(String(settingWrite()[0]!.values[1]));
const refusal = async (p: Promise<void>): Promise<DefaultAccountsRefusal> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(DefaultAccountsRefusal);
  return err as DefaultAccountsRefusal;
};

beforeEach(() => {
  stored = undefined;
  writes = [];
  loanAccounts = new Set();
  snapshot.holders = new Map();
  snapshot.contested = new Set();
  logAuditOrThrow.mockClear();
});

describe('payroll_net_pay: what a save refuses', () => {
  it('an unknown account id is a 400 "not found" and nothing is written or audited', async () => {
    const err = await refusal(save({ payroll_net_pay: '99999999-0000-4000-8000-000000000009' }, { payroll_net_pay: '' }));
    expect([err.status, err.message]).toEqual([400, "Account for 'payroll_net_pay' not found"]);
    expect(writes).toEqual([]);
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });

  it('an account that fails the rule (an asset) is a 400 that names it', async () => {
    const err = await refusal(save({ payroll_net_pay: ASSET }, { payroll_net_pay: '' }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/1110.*liability/);
    expect(writes).toEqual([]);
  });

  it('an account a loan uses is a 400, even on the payroll_liability subtype', async () => {
    loanAccounts = new Set([LOAN]);
    const err = await refusal(save({ payroll_net_pay: LOAN }, { payroll_net_pay: '' }));
    expect([err.status, err.message]).toEqual([400, expect.stringMatching(/2215.*loan/)]);
    expect(writes).toEqual([]);
  });

  it('a stale page is a 409, and an account that is wrong in itself is a 400 even when the page is stale', async () => {
    stored = { payroll_net_pay: C2170 };
    const stale = await refusal(save({ payroll_net_pay: C2171 }, { payroll_net_pay: '' }));
    expect([stale.status, stale.message]).toEqual([409, expect.stringMatching(/changed since you loaded/)]);
    const wrongAndStale = await refusal(save({ payroll_net_pay: ASSET }, { payroll_net_pay: '' }));
    expect(wrongAndStale.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('a stale CLEAR is a 409 too (the page loaded before 2170 was set)', async () => {
    stored = { payroll_net_pay: C2170 };
    const err = await refusal(save({ payroll_net_pay: '' }, { payroll_net_pay: '' }));
    expect(err.status).toBe(409);
  });

  it('the same account for net pay and a role is a 400', async () => {
    snapshot.holders = new Map([['payable', AP_OLD]]);
    const err = await refusal(save({ payroll_net_pay: C2170, accounts_payable: C2170 }, { payroll_net_pay: '', accounts_payable: AP_OLD }));
    expect(err.message).toMatch(/cannot hold two roles/);
    expect(writes).toEqual([]);
  });
});

describe('payroll_net_pay: what a save stores', () => {
  it('a valid choice is stored as the account id, next to the keys already stored, and audited with old and new', async () => {
    stored = { sales_discount: 'keep-me' };
    await save({ payroll_net_pay: C2170 }, { payroll_net_pay: '' });
    expect(storedJson()).toEqual({ sales_discount: 'keep-me', payroll_net_pay: C2170 });
    expect(logAuditOrThrow).toHaveBeenCalledTimes(1);
    const [params, db] = logAuditOrThrow.mock.calls[0] as [Record<string, any>, unknown];
    expect(db).toBe(tx); // the save's own transaction: the record commits or rolls back with the change
    expect(params).toMatchObject({ companyId: CO, userId: USER, action: 'update', entityType: 'default_accounts', entityId: CO });
    expect(params.changes.fields).toEqual([{
      field: 'payroll_net_pay', label: 'Default account: payroll_net_pay', old: null, new: `2170 Net Salaries Payable (${C2170})`,
    }]);
  });

  it('moving it from one account to another records both ids and codes', async () => {
    stored = { payroll_net_pay: C2170 };
    await save({ payroll_net_pay: C2171 }, { payroll_net_pay: C2170 });
    const fields = (logAuditOrThrow.mock.calls[0]![0] as Record<string, any>).changes.fields;
    expect(fields[0]).toMatchObject({ old: `2170 Net Salaries Payable (${C2170})`, new: `2171 Net Salaries Two (${C2171})` });
  });

  it('clearing it stores null (never an empty string), and audits the old account against nothing', async () => {
    stored = JSON.stringify({ payroll_net_pay: C2170 });
    await save({ payroll_net_pay: '' }, { payroll_net_pay: C2170 });
    const json = storedJson();
    expect(json).toEqual({ payroll_net_pay: null });
    expect(json.payroll_net_pay).toBeNull();
    const fields = (logAuditOrThrow.mock.calls[0]![0] as Record<string, any>).changes.fields;
    expect(fields[0]).toMatchObject({ old: `2170 Net Salaries Payable (${C2170})`, new: null });
  });

  it('naming the account that is already stored changes nothing: stored as it was, no audit row', async () => {
    stored = { payroll_net_pay: C2170, sales_discount: 'x' };
    await save({ payroll_net_pay: C2170, sales_discount: 'y' }, { payroll_net_pay: C2170 });
    expect(storedJson()).toEqual({ payroll_net_pay: C2170, sales_discount: 'y' });
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });

  it('a save that does not name it leaves the stored value alone, and an unmanaged key alone is not audited', async () => {
    stored = { payroll_net_pay: C2170 };
    await save({ sales_discount: 'z' }, {});
    expect(storedJson()).toEqual({ payroll_net_pay: C2170, sales_discount: 'z' });
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });

  it('reads a stored row that was written twice (JSON text of a JSON string) instead of dropping its keys', async () => {
    stored = JSON.stringify(JSON.stringify({ payroll_net_pay: C2170, sales_discount: 'keep' }));
    await save({ sales_discount: 'z' }, {});
    expect(storedJson()).toEqual({ payroll_net_pay: C2170, sales_discount: 'z' });
  });

  it.each(['"x"', '[]', '5', 'null'])('a stored non-object mapping (%s) reads as nothing and is replaced by the save', async (value) => {
    stored = value;
    await save({ sales_discount: 'z' }, {});
    expect(storedJson()).toEqual({ sales_discount: 'z' });
  });

  it('a sent value that is not an id or empty never reaches the store', async () => {
    const err = await refusal(save({ payroll_net_pay: 42 as unknown as string }, {}));
    expect(err.message).toMatch(/must be an account id or empty/);
    expect(writes).toEqual([]);
  });
});

describe('role moves are audited in the same save', () => {
  it('moving accounts_payable records the old and new holder, and the net pay change rides in the same row', async () => {
    snapshot.holders = new Map([['payable', AP_OLD]]);
    await save({ accounts_payable: AP_NEW, payroll_net_pay: C2170 }, { accounts_payable: AP_OLD, payroll_net_pay: '' });
    expect(logAuditOrThrow).toHaveBeenCalledTimes(1);
    const params = logAuditOrThrow.mock.calls[0]![0] as Record<string, any>;
    expect(params.userId).toBe(USER);
    expect(params.changes.fields.map((f: { field: string }) => f.field).sort()).toEqual(['accounts_payable', 'payroll_net_pay']);
    expect(params.changes.fields.find((f: { field: string }) => f.field === 'accounts_payable')).toMatchObject({
      old: `2110 Accounts Payable (${AP_OLD})`, new: `2111 Creditors (${AP_NEW})`,
    });
  });

  it('a role left as it is (the page re-sent the holder) is not a change and not audited', async () => {
    snapshot.holders = new Map([['payable', AP_OLD]]);
    await save({ accounts_payable: AP_OLD }, { accounts_payable: AP_OLD });
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });

  it('a save whose audit row cannot be written fails (so its transaction rolls back)', async () => {
    logAuditOrThrow.mockRejectedValueOnce(new Error('audit_log unavailable'));
    await expect(save({ payroll_net_pay: C2170 }, { payroll_net_pay: '' })).rejects.toThrow('audit_log unavailable');
  });
});
