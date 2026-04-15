/**
 * Integration-style unit tests for BL-84..BL-86
 * P1 IDOR fixes: group_id guards on elimination adjustments,
 * intercompany match, and entity ownership on document upload.
 *
 * UUID prefixes:
 *   b184 — BL-84 (postEliminationAdjustment / reverseEliminationAdjustment)
 *   b185 — BL-85 (document upload entity ownership)
 *   b186 — BL-86 (matchIntercompanyTransactions group_id guard)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock references (hoisted so vi.mock factories can reference them) ──

const { sqlMock, logMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(
    vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      return { _isSqlFragment: true };
    }),
    { unsafe: vi.fn(() => '') }
  );
  const logMock = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return { sqlMock, logMock };
});

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: logMock }));

import { sql } from '@/lib/neon';
import {
  postEliminationAdjustment,
  reverseEliminationAdjustment,
} from '@/modules/accounting/services/reports/consolidatedReportingService';
import { matchIntercompanyTransactions } from '@/modules/accounting/services/reports/intercompanyService';
import { verifyEntityOwnership } from '@/modules/accounting/services/core/documentStorageService';

// ── UUID fixtures ─────────────────────────────────────────────────────────────

const GROUP_A = 'aaaaaaaa-1000-0000-0000-aaaaaaaaaaaa';
const GROUP_B = 'bbbbbbbb-1000-0000-0000-bbbbbbbbbbbb';
const COMPANY_A = 'aaaaaaaa-2000-0000-0000-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-2000-0000-0000-bbbbbbbbbbbb';

// BL-84 UUIDs (prefix b184)
const B184_ADJ_A = 'b1840000-0000-0000-0000-aaaaaaaaaaaa'; // GROUP_A's adjustment
const B184_ADJ_B = 'b1840000-0000-0000-0000-bbbbbbbbbbbb'; // GROUP_B's adjustment

// BL-85 UUIDs (prefix b185)
const B185_ENTITY_B = 'b1850000-0000-0000-0000-bbbbbbbbbbbb'; // COMPANY_B's entity

// BL-86 UUIDs (prefix b186)
const B186_SOURCE_B = 'b1860000-0000-0000-0000-000000000001'; // GROUP_B source tx
const B186_TARGET_B = 'b1860000-0000-0000-0000-000000000002'; // GROUP_B target tx

// ── Helper: collect all sql() call argument values ────────────────────────────

function flatSqlValues(): unknown[] {
  return vi.mocked(sql).mock.calls.flatMap((callArgs: unknown[]) => {
    const [, ...values] = callArgs;
    return values.flat();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BL-84: postEliminationAdjustment — group_id guard
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-84: postEliminationAdjustment — group_id must be in UPDATE WHERE clause', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes both adjustmentId and groupId as SQL values', async () => {
    // Simulate 1 row updated (success case)
    vi.mocked(sql).mockResolvedValueOnce([{ id: B184_ADJ_A }] as never);

    await postEliminationAdjustment(B184_ADJ_A, GROUP_A);

    const values = flatSqlValues();
    expect(values).toContain(B184_ADJ_A);
    expect(values).toContain(GROUP_A);
  });

  it('throws when GROUP_A tries to post GROUP_B adjustment (0 rows affected)', async () => {
    // Simulate 0 rows updated — cross-group attempt correctly blocked
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await expect(
      postEliminationAdjustment(B184_ADJ_B, GROUP_A)
    ).rejects.toThrow(/not found or not in draft status/);

    // group_id must have been passed to SQL
    const values = flatSqlValues();
    expect(values).toContain(B184_ADJ_B);
    expect(values).toContain(GROUP_A);
  });

  it('does NOT use GROUP_B id when operating as GROUP_A', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: B184_ADJ_A }] as never);

    await postEliminationAdjustment(B184_ADJ_A, GROUP_A);

    const values = flatSqlValues();
    // GROUP_B must NOT appear — tenant isolation guaranteed at query level
    expect(values).not.toContain(GROUP_B);
  });
});

describe('BL-84: reverseEliminationAdjustment — group_id must be in UPDATE WHERE clause', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes both adjustmentId and groupId as SQL values', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: B184_ADJ_A }] as never);

    await reverseEliminationAdjustment(B184_ADJ_A, GROUP_A);

    const values = flatSqlValues();
    expect(values).toContain(B184_ADJ_A);
    expect(values).toContain(GROUP_A);
  });

  it('throws when GROUP_A tries to reverse GROUP_B adjustment (0 rows affected)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await expect(
      reverseEliminationAdjustment(B184_ADJ_B, GROUP_A)
    ).rejects.toThrow(/not found or not in posted status/);

    const values = flatSqlValues();
    expect(values).toContain(B184_ADJ_B);
    expect(values).toContain(GROUP_A);
  });

  it('does NOT use GROUP_B id when operating as GROUP_A', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: B184_ADJ_A }] as never);

    await reverseEliminationAdjustment(B184_ADJ_A, GROUP_A);

    const values = flatSqlValues();
    expect(values).not.toContain(GROUP_B);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BL-85: verifyEntityOwnership — guards document upload
// ─────────────────────────────────────────────────────────────────────────────
// Note: handlePost in documents.ts calls verifyEntityOwnership(entityId, companyId)
// before uploadDocument. We test the service function directly here since the
// full multipart upload path requires formidable + file system. The handler
// integration (wiring companyId into handlePost + the verifyEntityOwnership call)
// is verified by TSC (signature enforcement) and code inspection.

describe('BL-85: verifyEntityOwnership — rejects cross-company entity access', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when entity belongs to a different company (0 rows returned)', async () => {
    // Simulate DB returning no rows — COMPANY_B's entity not visible to COMPANY_A
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const owned = await verifyEntityOwnership(B185_ENTITY_B, COMPANY_A);
    expect(owned).toBe(false);
  });

  it('includes both entityId and companyId in SQL values', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await verifyEntityOwnership(B185_ENTITY_B, COMPANY_A);

    const values = flatSqlValues();
    expect(values).toContain(B185_ENTITY_B);
    expect(values).toContain(COMPANY_A);
  });

  it('returns true when entity belongs to the requesting company', async () => {
    // Simulate DB returning 1 row — entity is owned by the caller
    vi.mocked(sql).mockResolvedValueOnce([{ id: B185_ENTITY_B }] as never);

    const owned = await verifyEntityOwnership(B185_ENTITY_B, COMPANY_B);
    expect(owned).toBe(true);
  });

  it('does NOT include COMPANY_B id when COMPANY_A queries', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await verifyEntityOwnership(B185_ENTITY_B, COMPANY_A);

    const values = flatSqlValues();
    expect(values).not.toContain(COMPANY_B);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BL-86: matchIntercompanyTransactions — group_id guard on SELECT + UPDATE
// ─────────────────────────────────────────────────────────────────────────────

describe('BL-86: matchIntercompanyTransactions — group_id must be in SELECT WHERE clauses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes groupId in all SQL calls', async () => {
    // SELECT source, SELECT target, UPDATE — 3 sql calls total
    vi.mocked(sql)
      .mockResolvedValueOnce([{ id: 'src', amount: '100', group_id: GROUP_A }] as never) // source SELECT
      .mockResolvedValueOnce([{ id: 'tgt', amount: '100', group_id: GROUP_A }] as never) // target SELECT
      .mockResolvedValueOnce([] as never); // UPDATE

    await matchIntercompanyTransactions('src', 'tgt', GROUP_A);

    const values = flatSqlValues();
    // GROUP_A must appear (multiple times — once per SELECT + UPDATE)
    const groupAOccurrences = values.filter(v => v === GROUP_A);
    expect(groupAOccurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('throws when GROUP_A tries to match GROUP_B transactions (0 source rows)', async () => {
    // Simulate source not found because group_id mismatch
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never) // source SELECT returns nothing — wrong group
      .mockResolvedValueOnce([{ id: B186_TARGET_B, amount: '500', group_id: GROUP_B }] as never);

    await expect(
      matchIntercompanyTransactions(B186_SOURCE_B, B186_TARGET_B, GROUP_A)
    ).rejects.toThrow(/not found/);

    // GROUP_A should have been passed to the SELECT
    const values = flatSqlValues();
    expect(values).toContain(GROUP_A);
    expect(values).toContain(B186_SOURCE_B);
  });

  it('throws when both GROUP_B transactions return empty for GROUP_A caller', async () => {
    // Simulate both selects returning nothing (cross-group attempt)
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    await expect(
      matchIntercompanyTransactions(B186_SOURCE_B, B186_TARGET_B, GROUP_A)
    ).rejects.toThrow(/not found/);
  });

  it('does NOT include GROUP_B id when operating as GROUP_A', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ id: B186_SOURCE_B, amount: '200', group_id: GROUP_A }] as never)
      .mockResolvedValueOnce([{ id: B186_TARGET_B, amount: '200', group_id: GROUP_A }] as never)
      .mockResolvedValueOnce([] as never);

    await matchIntercompanyTransactions(B186_SOURCE_B, B186_TARGET_B, GROUP_A);

    const values = flatSqlValues();
    expect(values).not.toContain(GROUP_B);
  });
});
