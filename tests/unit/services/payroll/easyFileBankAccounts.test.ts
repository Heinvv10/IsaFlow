/**
 * Wave 7 EA2: the e@syFile file's bank accounts are read only through the audited reader (getEmployeeBankDetails +
 * auditBankDetailsRead), only for an owner or admin in their own session, one audit row per account read in full.
 * The real-PG proof (two tenants, the audit_log rows, the file bytes) is tests/integration/w7-ea2-easyfile-contacts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  human: true,
  details: new Map<string, unknown>(),
  reads: [] as Array<{ employeeId: string; role: string | undefined }>,
  audits: [] as Array<{ companyId: string; detailsId: string }>,
}));

vi.mock('@/modules/accounting/services/bank/bankControlRefusal', () => ({ isHumanSession: async () => st.human }));
vi.mock('@/modules/accounting/services/payroll/payrollBankDetailsService', () => ({
  getEmployeeBankDetails: async (_c: string, employeeId: string, role: string | undefined) => {
    st.reads.push({ employeeId, role });
    return st.details.get(employeeId) ?? null;
  },
}));
vi.mock('@/modules/accounting/services/payroll/payrollBankReadAudit', () => ({
  auditBankDetailsRead: async (companyId: string, _a: unknown, d: { id: string }) => { st.audits.push({ companyId, detailsId: d.id }); },
}));

import { contactPolicyOf, loadCertificateBankAccounts } from '@/modules/accounting/services/payroll/easyFileBankAccounts';

const actor = { userId: 'u1', userEmail: 'u1@example.invalid', ip: '198.18.0.1', userAgent: 'vitest' };
const full = (id: string, o: Record<string, unknown> = {}) => ({
  id: `bd-${id}`, employeeId: id, bankName: 'FNB', accountNumber: '62000000001', masked: false, accountType: 'cheque',
  branchCode: '250655', accountHolder: 'A Person', accountHolderRelationship: null, effectiveFrom: '2026-01-01', ...o,
});
const emps = [{ id: 'e1', name: 'Ann One' }, { id: 'e2', name: 'Ben Two' }, { id: 'e3', name: 'Cat Three' }];

beforeEach(() => {
  st.human = true;
  st.reads = [];
  st.audits = [];
  st.details = new Map<string, unknown>([['e1', full('e1')], ['e2', full('e2', { accountHolder: null })]]);
});

describe('loadCertificateBankAccounts', () => {
  it.each(['owner', 'admin'])('%s in their own session: every account read in full, one audit row each, none for no account', async (role) => {
    const out = await loadCertificateBankAccounts('c1', emps, { role, actor });
    expect(out.written).toBe(true);
    // Cat has no account on record: 3240 = 0 (ruling 25), not read, not audited.
    expect([...out.byEmployee.keys()]).toEqual(['e1', 'e2', 'e3']);
    expect(out.byEmployee.get('e3')).toEqual({ notElectronic: true });
    expect(out.byEmployee.get('e1')).toMatchObject({ accountType: 'cheque', accountNumber: '62000000001', branchCode: '250655' });
    expect(st.reads.map((r) => r.role)).toEqual([role, role, role]);
    expect(st.audits).toEqual([{ companyId: 'c1', detailsId: 'bd-e1' }, { companyId: 'c1', detailsId: 'bd-e2' }]);
    // Ben has no holder (3245) and neither states who holds it (3246): named, never a number.
    expect(out.warnings).toEqual([expect.stringMatching(/^Ann One: .*3246/), expect.stringMatching(/^Ben Two: .*3245/), expect.stringMatching(/^Ben Two: .*3246/)]);
    expect(out.warnings.join(' ')).not.toContain('62000000001');
  });

  it.each([['manager'], ['viewer'], [undefined]])('role %s: reads nothing, audits nothing, writes nothing', async (role) => {
    const out = await loadCertificateBankAccounts('c1', emps, { role, actor });
    expect([out.written, out.byEmployee.size, st.reads.length, st.audits.length]).toEqual([false, 0, 0, 0]);
  });

  it('Login-as or a token (not a human session): reads nothing even for an owner', async () => {
    st.human = false;
    const out = await loadCertificateBankAccounts('c1', emps, { role: 'owner', actor });
    expect([out.written, st.reads.length, st.audits.length]).toEqual([false, 0, 0]);
  });

  it('no reader (the EMP501 figures): reads nothing', async () => {
    const out = await loadCertificateBankAccounts('c1', emps, undefined);
    expect([out.written, st.reads.length]).toEqual([false, 0]);
  });

  it('an account the certificate cannot carry is left off, named, and its read is still audited', async () => {
    st.details.set('e3', full('e3', { accountNumber: '62-000' }));
    const out = await loadCertificateBankAccounts('c1', emps, { role: 'owner', actor });
    expect(out.byEmployee.has('e3')).toBe(false);
    expect(out.warnings).toContainEqual(expect.stringMatching(/^Cat Three: .*3241/));
    expect(st.audits.map((a) => a.detailsId)).toContain('bd-e3');
  });

  it('refuses a masked view rather than write it to the file', async () => {
    st.details.set('e1', full('e1', { masked: true, accountNumber: '…0001' }));
    await expect(loadCertificateBankAccounts('c1', emps, { role: 'owner', actor })).rejects.toThrow(/masked/);
  });
});

describe('contactPolicyOf (the address and bank-details routes\' rule: a person in their own session)', () => {
  it.each([
    ['owner', true, { address: true, bank: true }], ['admin', true, { address: true, bank: true }],
    ['manager', true, { address: true, bank: false }],
    ['owner', false, { address: false, bank: false }], ['manager', false, { address: false, bank: false }],
  ] as const)('%s, human session %s: %j', async (role, human, want) => {
    st.human = human;
    expect(await contactPolicyOf({ role, actor })).toEqual(want);
  });
  it('no reader (the EMP501 figures, stored and never served to the builder): the address, never an account', async () => {
    st.human = false;
    expect(await contactPolicyOf(undefined)).toEqual({ address: true, bank: false });
  });
});

describe('own account with no holder (3245 from the employee, 3246 = 1)', () => {
  it('names the employee and raises no warning', async () => {
    st.details = new Map<string, unknown>([['e1', full('e1', { accountHolder: null, accountHolderRelationship: 'own' })]]);
    const out = await loadCertificateBankAccounts('c1', [emps[0]!], { role: 'owner', actor });
    expect(out.byEmployee.get('e1')).toMatchObject({ accountHolder: 'Ann One', holderRelationship: 'own' });
    expect(out.warnings).toEqual([]);
  });
});
