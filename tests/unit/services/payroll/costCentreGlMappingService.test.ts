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

import {
  listCostCentreGlMappings,
  upsertCostCentreGlMapping,
  deleteCostCentreGlMapping,
} from '@/modules/accounting/services/payroll/costCentreGlMappingService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CC_ID = 'cc000001-0000-0000-0000-000000000001';
const ACCT_ID = 'acct0001-0000-0000-0000-000000000001';
const USER_ID = 'user-1';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('listCostCentreGlMappings', () => {
  it('joins centres + accounts and scopes by company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM cost_centre_gl_mappings')) {
        return Promise.resolve([{
          id: 'm1', cost_centre_id: CC_ID, cost_centre_code: 'ADMIN', cost_centre_name: 'Admin',
          expense_account_id: ACCT_ID, account_code: '5100', account_name: 'Admin Salaries',
        }]);
      }
      return Promise.resolve([]);
    };
    const rows = await listCostCentreGlMappings(COMPANY_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costCentreCode).toBe('ADMIN');
    expect(rows[0]!.accountCode).toBe('5100');
    const call = sqlCalls.find(c => c.sql.includes('FROM cost_centre_gl_mappings'));
    expect(call!.values).toContain(COMPANY_ID);
  });
});

describe('upsertCostCentreGlMapping', () => {
  it('inserts with ON CONFLICT when centre + account both belong to company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM cost_centres')) return Promise.resolve([{ id: CC_ID }]);
      if (q.includes('FROM gl_accounts')) return Promise.resolve([{ id: ACCT_ID }]);
      return Promise.resolve([]);
    };
    await upsertCostCentreGlMapping(COMPANY_ID, CC_ID, ACCT_ID, USER_ID);
    const insert = sqlCalls.find(c => c.sql.includes('INSERT INTO cost_centre_gl_mappings'));
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/ON CONFLICT/);
  });

  it('rejects cost centre outside company', async () => {
    mockImpl = () => Promise.resolve([]);
    await expect(upsertCostCentreGlMapping(COMPANY_ID, CC_ID, ACCT_ID, USER_ID))
      .rejects.toThrow(/cost centre/i);
  });

  it('rejects account outside company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM cost_centres')) return Promise.resolve([{ id: CC_ID }]);
      if (q.includes('FROM gl_accounts')) return Promise.resolve([]);
      return Promise.resolve([]);
    };
    await expect(upsertCostCentreGlMapping(COMPANY_ID, CC_ID, ACCT_ID, USER_ID))
      .rejects.toThrow(/account/i);
  });
});

describe('deleteCostCentreGlMapping', () => {
  it('deletes scoped by company', async () => {
    mockImpl = () => Promise.resolve([]);
    await deleteCostCentreGlMapping(COMPANY_ID, CC_ID);
    const del = sqlCalls.find(c => c.sql.includes('DELETE FROM cost_centre_gl_mappings'));
    expect(del).toBeDefined();
    expect(del!.values).toContain(COMPANY_ID);
    expect(del!.values).toContain(CC_ID);
  });
});
