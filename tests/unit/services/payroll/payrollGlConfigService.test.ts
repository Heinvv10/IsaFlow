import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  getPayrollGlMappings,
  upsertPayrollGlMappings,
  getCompletePayrollGlMappings,
  PAYROLL_GL_ROLES,
  type PayrollGlMapping,
} from '@/modules/accounting/services/payroll/payrollGlConfigService';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GL_ACCOUNT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const ALL_7_ROWS = PAYROLL_GL_ROLES.map(role => ({
  role,
  gl_account_id: GL_ACCOUNT_ID,
}));

describe('getPayrollGlMappings', () => {
  it('returns [] when no rows exist', async () => {
    mockImpl = () => Promise.resolve([]);
    const result = await getPayrollGlMappings(COMPANY_ID);
    expect(result).toEqual([]);
  });

  it('filters by company_id — SQL contains company_id', async () => {
    mockImpl = () =>
      Promise.resolve([{ role: 'salaries_expense', gl_account_id: GL_ACCOUNT_ID }]);
    await getPayrollGlMappings(COMPANY_ID);
    expect(sqlCalls.length).toBeGreaterThan(0);
    expect(sqlCalls[0]!.sql).toContain('company_id');
    expect(sqlCalls[0]!.values).toContain(COMPANY_ID);
  });

  it('maps snake_case rows to camelCase PayrollGlMapping', async () => {
    mockImpl = () =>
      Promise.resolve([{ role: 'salaries_expense', gl_account_id: GL_ACCOUNT_ID }]);
    const result = await getPayrollGlMappings(COMPANY_ID);
    expect(result).toEqual([{ role: 'salaries_expense', glAccountId: GL_ACCOUNT_ID }]);
  });
});

describe('upsertPayrollGlMappings', () => {
  it('inserts a new mapping — SQL contains INSERT and ON CONFLICT', async () => {
    const mapping: PayrollGlMapping = { role: 'salaries_expense', glAccountId: GL_ACCOUNT_ID };
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('INSERT')) return Promise.resolve([]);
      if (q.includes('SELECT') || q.includes('FROM payroll_gl_accounts')) return Promise.resolve([]);
      return Promise.resolve([]);
    };
    await upsertPayrollGlMappings(COMPANY_ID, [mapping]);
    const insertCall = sqlCalls.find(c => c.sql.includes('INSERT'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toContain('ON CONFLICT');
    expect(insertCall!.values).toContain(GL_ACCOUNT_ID);
  });

  it('updates via ON CONFLICT when role exists — same assertion set, mock returns existing row', async () => {
    const mapping: PayrollGlMapping = {
      role: 'paye_payable',
      glAccountId: GL_ACCOUNT_ID,
    };
    const existingRow = { role: 'paye_payable', gl_account_id: GL_ACCOUNT_ID };
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('INSERT')) return Promise.resolve([existingRow]);
      return Promise.resolve([existingRow]);
    };
    const result = await upsertPayrollGlMappings(COMPANY_ID, [mapping]);
    const insertCall = sqlCalls.find(c => c.sql.includes('INSERT'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toContain('ON CONFLICT');
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'paye_payable' })]));
  });

  it('deletes when glAccountId === "" — SQL contains DELETE', async () => {
    const mapping: PayrollGlMapping = { role: 'uif_payable', glAccountId: '' };
    await upsertPayrollGlMappings(COMPANY_ID, [mapping]);
    const deleteCall = sqlCalls.find(c => c.sql.includes('DELETE'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.sql).toContain('company_id');
    expect(deleteCall!.values).toContain('uif_payable');
  });

  it('throws on unknown role', async () => {
    const mapping = { role: 'bogus' as unknown as PayrollGlMapping['role'], glAccountId: GL_ACCOUNT_ID };
    await expect(upsertPayrollGlMappings(COMPANY_ID, [mapping])).rejects.toThrow(
      'Unknown payroll GL role: bogus',
    );
  });
});

describe('getCompletePayrollGlMappings', () => {
  it('throws when fewer than 7 roles configured — error mentions missing role names', async () => {
    // Only 3 roles returned
    const partial = ALL_7_ROWS.slice(0, 3);
    mockImpl = () => Promise.resolve(partial);
    await expect(getCompletePayrollGlMappings(COMPANY_ID)).rejects.toThrow(
      /missing:/,
    );
    // The error message should mention at least one of the missing roles
    await getCompletePayrollGlMappings(COMPANY_ID).catch(err => {
      const missing = PAYROLL_GL_ROLES.slice(3);
      for (const role of missing) {
        expect((err as Error).message).toContain(role);
      }
    });
  });

  it('returns complete Record when all 7 roles configured', async () => {
    mockImpl = () => Promise.resolve(ALL_7_ROWS);
    const result = await getCompletePayrollGlMappings(COMPANY_ID);
    for (const role of PAYROLL_GL_ROLES) {
      expect(result[role]).toBe(GL_ACCOUNT_ID);
    }
  });
});
