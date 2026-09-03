// RED phase — written before implementation
/**
 * company_relationships audit trail + removal (migration 531).
 *
 * Two gaps this covers:
 *  (a) `createCompanyRelationship` took `_userId` and threw it away, so nothing
 *      recorded WHO attached a subsidiary — and attaching one grants the parent
 *      read access to the child's whole GL through consolidation/trial-balance.
 *  (b) There was no removal path at all, so a mistaken (or malicious) link could
 *      only be undone with raw SQL.
 *
 * Removal is a SOFT delete: the row is the audit record of a cross-tenant read
 * grant, so who granted it and who revoked it must survive the revocation. That
 * makes `deleted_at IS NULL` load-bearing on every read — a read that forgets it
 * keeps the GL leak alive — so both read paths are asserted here.
 *
 * SQL-text assertions strip `--` comments first, so shipping an explanatory
 * comment containing the asserted phrase cannot mask a deleted predicate.
 *
 * Mutation checks (apply each alone, expect red):
 *  1. Drop `created_by` from the INSERT column list → "records created_by" fails.
 *  2. Drop `AND deleted_at IS NULL` from getChildCompanyIds' query
 *     → "getIntercompanyBalances excludes soft-deleted children" fails.
 *  3. Drop `AND cr.deleted_at IS NULL` from getGroupCompanies' child query
 *     → "getGroupCompanies excludes soft-deleted children" fails.
 *  4. Drop `AND parent_company_id = ${companyId}` from deleteCompanyRelationship
 *     → "scopes the delete to the calling parent" fails.
 *  5. Make deleteCompanyRelationship return true unconditionally
 *     → "returns false when no matching active relationship" fails.
 *  6. Make it a hard `DELETE FROM` → "soft-deletes rather than hard-deletes" fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  createCompanyRelationship,
  deleteCompanyRelationship,
  getGroupCompanies,
  getIntercompanyBalances,
} from '@/modules/accounting/services/reports/consolidationService';

const PARENT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CHILD_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID = 'cccccccc-0000-0000-0000-000000000003';

/** SQL text of call `i`, lowercased with `-- …` comments stripped. */
function sqlText(i: number): string {
  const [strings] = vi.mocked(sql).mock.calls[i] as unknown as [TemplateStringsArray];
  return strings
    .join(' ? ')
    .replace(/--[^\n]*/g, '')
    .toLowerCase();
}

function boundValues(i: number): unknown[] {
  return Array.from(vi.mocked(sql).mock.calls[i] ?? []).slice(1);
}

describe('createCompanyRelationship — audit trail', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('records created_by so the grant is attributable', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await createCompanyRelationship(PARENT_ID, CHILD_ID, 75, USER_ID);

    expect(sqlText(0)).toContain('created_by');
    expect(boundValues(0)).toContain(USER_ID);
  });

  it('revives a previously removed link instead of leaving it soft-deleted', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await createCompanyRelationship(PARENT_ID, CHILD_ID, 100, USER_ID);

    const text = sqlText(0);
    expect(text).toContain('on conflict');
    expect(text).toMatch(/deleted_at\s*=\s*null/);
  });
});

describe('deleteCompanyRelationship', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('soft-deletes rather than hard-deletes, recording who removed it', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'rel-1' }] as never);

    await deleteCompanyRelationship(PARENT_ID, CHILD_ID, USER_ID);

    const text = sqlText(0);
    expect(text).toContain('update company_relationships');
    expect(text).not.toContain('delete from');
    expect(text).toContain('deleted_at');
    expect(text).toContain('deleted_by');
    expect(boundValues(0)).toContain(USER_ID);
  });

  it('scopes the delete to the calling parent and the named child', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'rel-1' }] as never);

    await deleteCompanyRelationship(PARENT_ID, CHILD_ID, USER_ID);

    const text = sqlText(0);
    expect(text).toContain('parent_company_id');
    expect(text).toContain('child_company_id');
    const bound = boundValues(0);
    expect(bound).toContain(PARENT_ID);
    expect(bound).toContain(CHILD_ID);
  });

  it('returns true when a row was removed', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'rel-1' }] as never);
    await expect(deleteCompanyRelationship(PARENT_ID, CHILD_ID, USER_ID)).resolves.toBe(true);
  });

  it('returns false when no matching active relationship exists', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    await expect(deleteCompanyRelationship(PARENT_ID, CHILD_ID, USER_ID)).resolves.toBe(false);
  });

  it('rejects an attempt to remove the company from itself', async () => {
    await expect(
      deleteCompanyRelationship(PARENT_ID, PARENT_ID, USER_ID),
    ).rejects.toThrow('cannot be its own subsidiary');
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });
});

describe('soft-deleted links are invisible to consolidated reads', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('getGroupCompanies excludes soft-deleted children', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ id: PARENT_ID, name: 'Holding Co' }] as never)
      .mockResolvedValueOnce([] as never);

    await getGroupCompanies(PARENT_ID);

    expect(sqlText(1)).toMatch(/deleted_at\s+is\s+null/);
  });

  it('getIntercompanyBalances excludes soft-deleted children', async () => {
    // call 0 = getChildCompanyIds
    vi.mocked(sql).mockResolvedValue([] as never);

    await getIntercompanyBalances(PARENT_ID, '2026-01-01', '2026-01-31');

    expect(sqlText(0)).toContain('company_relationships');
    expect(sqlText(0)).toMatch(/deleted_at\s+is\s+null/);
  });
});
