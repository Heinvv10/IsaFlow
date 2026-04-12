// RED phase — written before implementation
/**
 * Unit tests for consolidationService.ts
 *
 * Uses mocked sql to simulate DB responses without a live DB connection.
 * Verifies IDOR scoping (companyId always passed), shape of returned objects,
 * and aggregation logic in getConsolidatedTrialBalance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  getGroupCompanies,
  createCompanyRelationship,
  getConsolidatedTrialBalance,
} from '@/modules/accounting/services/consolidationService';
import type { GroupCompany } from '@/modules/accounting/services/consolidationService';

const PARENT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CHILD_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID   = 'cccccccc-0000-0000-0000-000000000003';

// ── Sample data ───────────────────────────────────────────────────────────────

const parentRow = { id: PARENT_ID, name: 'Holding Co' };

const childRow = {
  id: CHILD_ID,
  name: 'Operating Sub',
  relationship_type: 'subsidiary',
  ownership_percent: 75,
};

function makeGlRow(overrides: Record<string, unknown> = {}) {
  return {
    account_code: '1000',
    account_name: 'Cash',
    account_type: 'asset',
    total_debit: 50_000,
    total_credit: 10_000,
    ...overrides,
  };
}

// ── getGroupCompanies ─────────────────────────────────────────────────────────

describe('getGroupCompanies', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('returns parent first with ownershipPercent 100', async () => {
    // First call: SELECT companies (parent lookup)
    vi.mocked(sql)
      .mockResolvedValueOnce([parentRow])   // self row
      .mockResolvedValueOnce([childRow]);   // child rows

    const result = await getGroupCompanies(PARENT_ID);

    expect(result[0]).toMatchObject({
      id: PARENT_ID,
      name: 'Holding Co',
      relationshipType: 'parent',
      ownershipPercent: 100,
    });
  });

  it('includes children after parent with correct ownershipPercent', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([parentRow])
      .mockResolvedValueOnce([childRow]);

    const result = await getGroupCompanies(PARENT_ID);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      id: CHILD_ID,
      name: 'Operating Sub',
      relationshipType: 'subsidiary',
      ownershipPercent: 75,
    });
  });

  it('returns only parent when no children exist', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([parentRow])
      .mockResolvedValueOnce([]);

    const result = await getGroupCompanies(PARENT_ID);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(PARENT_ID);
  });

  it('passes companyId as interpolated argument in both sql calls', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([parentRow])
      .mockResolvedValueOnce([]);

    await getGroupCompanies(PARENT_ID);

    // Both the self-lookup and the child-lookup should scope to PARENT_ID
    const allInterpolated = vi.mocked(sql).mock.calls.flatMap((c) =>
      Array.from(c).slice(1)
    );
    const mentions = allInterpolated.filter((v) => v === PARENT_ID);
    expect(mentions.length).toBeGreaterThanOrEqual(2);
  });

  it('throws when parent company does not exist', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]); // no self row

    await expect(getGroupCompanies(PARENT_ID)).rejects.toThrow(PARENT_ID);
  });

  it('returns GroupCompany objects with correct interface shape', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([parentRow])
      .mockResolvedValueOnce([childRow]);

    const result = await getGroupCompanies(PARENT_ID);

    for (const company of result) {
      expect(company).toHaveProperty('id');
      expect(company).toHaveProperty('name');
      expect(company).toHaveProperty('relationshipType');
      expect(company).toHaveProperty('ownershipPercent');
      expect(typeof company.ownershipPercent).toBe('number');
    }
  });
});

// ── createCompanyRelationship ─────────────────────────────────────────────────

describe('createCompanyRelationship', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('rejects when childCompanyId equals companyId (own-subsidiary guard)', async () => {
    await expect(
      createCompanyRelationship(PARENT_ID, PARENT_ID, 100, USER_ID)
    ).rejects.toThrow('cannot be its own subsidiary');
  });

  it('rejects when ownershipPercent is negative', async () => {
    await expect(
      createCompanyRelationship(PARENT_ID, CHILD_ID, -1, USER_ID)
    ).rejects.toThrow('ownershipPercent');
  });

  it('rejects when ownershipPercent exceeds 100', async () => {
    await expect(
      createCompanyRelationship(PARENT_ID, CHILD_ID, 101, USER_ID)
    ).rejects.toThrow('ownershipPercent');
  });

  it('calls sql INSERT with parent, child, and ownership values', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await createCompanyRelationship(PARENT_ID, CHILD_ID, 75, USER_ID);

    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(PARENT_ID);
    expect(interpolated).toContain(CHILD_ID);
    expect(interpolated).toContain(75);
  });

  it('uses ON CONFLICT DO UPDATE (upsert, not error on duplicate)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    // Should not throw even if we call it twice
    await createCompanyRelationship(PARENT_ID, CHILD_ID, 51, USER_ID);

    const [templateStrings] = vi.mocked(sql).mock.calls[0];
    const fullSql = (templateStrings as TemplateStringsArray).join('').toLowerCase();
    expect(fullSql).toContain('on conflict');
  });

  it('defaults to "subsidiary" relationship type', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await createCompanyRelationship(PARENT_ID, CHILD_ID, 100, USER_ID);

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain('subsidiary');
  });

  it('accepts custom relationship type', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await createCompanyRelationship(PARENT_ID, CHILD_ID, 100, USER_ID, 'branch');

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain('branch');
  });

  it('resolves without a return value on success', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await expect(
      createCompanyRelationship(PARENT_ID, CHILD_ID, 60, USER_ID)
    ).resolves.toBeUndefined();
  });

  it('rethrows on SQL error', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('FK violation'));

    await expect(
      createCompanyRelationship(PARENT_ID, CHILD_ID, 60, USER_ID)
    ).rejects.toThrow('FK violation');
  });
});

// ── getConsolidatedTrialBalance ───────────────────────────────────────────────

describe('getConsolidatedTrialBalance', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  /**
   * The function calls sql in this sequence:
   * 1. Self company lookup (getGroupCompanies → SELECT companies)
   * 2. Child company lookup (getGroupCompanies → SELECT company_relationships)
   * 3. Eliminated types lookup (getEliminatedTypes)
   * 4. GL rows per entity (one query per group member — parent + each child)
   */
  function setupMocks(glRows: Record<string, unknown>[] = [makeGlRow()]) {
    vi.mocked(sql)
      .mockResolvedValueOnce([parentRow])          // 1. self lookup
      .mockResolvedValueOnce([])                   // 2. no children
      .mockResolvedValueOnce([])                   // 3. no eliminations
      .mockResolvedValueOnce(glRows);              // 4. GL rows for parent
  }

  it('returns correct top-level shape', async () => {
    setupMocks();

    const result = await getConsolidatedTrialBalance(PARENT_ID, '2026-01-01', '2026-03-31');

    expect(result).toHaveProperty('groupName');
    expect(result).toHaveProperty('periodStart', '2026-01-01');
    expect(result).toHaveProperty('periodEnd', '2026-03-31');
    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('accounts');
    expect(result).toHaveProperty('totalDebits');
    expect(result).toHaveProperty('totalCredits');
  });

  it('groupName is the parent company name', async () => {
    setupMocks();

    const result = await getConsolidatedTrialBalance(PARENT_ID, '2026-01-01', '2026-03-31');

    expect(result.groupName).toBe('Holding Co');
  });

  it('entities array contains one entry for a single-entity group', async () => {
    setupMocks();

    const result = await getConsolidatedTrialBalance(PARENT_ID, '2026-01-01', '2026-03-31');

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      companyId: PARENT_ID,
      companyName: 'Holding Co',
    });
  });

  it('totalDebits equals the sum of all account totalDebit fields', async () => {
    setupMocks([
      makeGlRow({ account_code: '1000', total_debit: 50_000, total_credit: 10_000 }),
      makeGlRow({ account_code: '2000', account_type: 'liability', total_debit: 5_000, total_credit: 30_000 }),
    ]);

    const result = await getConsolidatedTrialBalance(PARENT_ID, '2026-01-01', '2026-03-31');

    const expectedDebits = result.accounts.reduce((s, a) => s + a.totalDebit, 0);
    expect(result.totalDebits).toBe(expectedDebits);
  });

  it('totalCredits equals the sum of all account totalCredit fields', async () => {
    setupMocks([
      makeGlRow({ account_code: '1000', total_debit: 50_000, total_credit: 10_000 }),
      makeGlRow({ account_code: '2000', account_type: 'liability', total_debit: 5_000, total_credit: 30_000 }),
    ]);

    const result = await getConsolidatedTrialBalance(PARENT_ID, '2026-01-01', '2026-03-31');

    const expectedCredits = result.accounts.reduce((s, a) => s + a.totalCredit, 0);
    expect(result.totalCredits).toBe(expectedCredits);
  });

  it('returns empty accounts array when GL has no transactions in period', async () => {
    setupMocks([]); // no GL rows

    const result = await getConsolidatedTrialBalance(PARENT_ID, '2026-01-01', '2026-03-31');

    expect(result.accounts).toEqual([]);
    expect(result.totalDebits).toBe(0);
    expect(result.totalCredits).toBe(0);
  });

  it('each account has a byEntity key for every entity in the group', async () => {
    // Two entities: parent + child
    vi.mocked(sql)
      .mockResolvedValueOnce([parentRow])                // self
      .mockResolvedValueOnce([childRow])                 // child
      .mockResolvedValueOnce([])                         // eliminations
      .mockResolvedValueOnce([makeGlRow()])              // parent GL
      .mockResolvedValueOnce([                           // child GL
        makeGlRow({ account_code: '1000', total_debit: 20_000, total_credit: 5_000 }),
      ]);

    const result = await getConsolidatedTrialBalance(PARENT_ID, '2026-01-01', '2026-03-31');

    for (const account of result.accounts) {
      expect(account.byEntity).toHaveProperty(PARENT_ID);
      expect(account.byEntity).toHaveProperty(CHILD_ID);
    }
  });

  it('aggregates debit/credit across entities for the same account code', async () => {
    const glParent = makeGlRow({ account_code: '1000', total_debit: 50_000, total_credit: 10_000 });
    const glChild  = makeGlRow({ account_code: '1000', total_debit: 20_000, total_credit:  5_000 });

    vi.mocked(sql)
      .mockResolvedValueOnce([parentRow])
      .mockResolvedValueOnce([childRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([glParent])
      .mockResolvedValueOnce([glChild]);

    const result = await getConsolidatedTrialBalance(PARENT_ID, '2026-01-01', '2026-03-31');

    const acc = result.accounts.find((a) => a.accountCode === '1000');
    expect(acc).toBeDefined();
    expect(acc!.totalDebit).toBe(70_000);  // 50k + 20k
    expect(acc!.totalCredit).toBe(15_000); // 10k + 5k
  });

  it('accounts are sorted by accountCode', async () => {
    setupMocks([
      makeGlRow({ account_code: '3000', account_type: 'equity', total_debit: 0, total_credit: 100_000 }),
      makeGlRow({ account_code: '1000', account_type: 'asset', total_debit: 50_000, total_credit: 0 }),
    ]);

    const result = await getConsolidatedTrialBalance(PARENT_ID, '2026-01-01', '2026-03-31');

    expect(result.accounts[0]?.accountCode).toBe('1000');
    expect(result.accounts[1]?.accountCode).toBe('3000');
  });
});
