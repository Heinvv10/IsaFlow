/**
 * P6 PR C: the three-way route input schemas (spec §7).
 */
import { describe, expect, it } from 'vitest';
import {
  AssumptionsPutSchema, CompareQuerySchema, DeriveBodySchema, ThreeWayQuerySchema, VersionQuerySchema,
} from '@/modules/accounting/services/budgets/threeWay/routeSchemas';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

describe('GET index query', () => {
  it('version_id and fiscal_year are optional; fiscal_year is a number', () => {
    expect(ThreeWayQuerySchema.parse({})).toEqual({});
    expect(ThreeWayQuerySchema.parse({ version_id: A, fiscal_year: '2027' })).toEqual({ version_id: A, fiscal_year: 2027 });
  });
  it('refuses a non-UUID version, a bad year and a repeated key', () => {
    expect(ThreeWayQuerySchema.safeParse({ version_id: 'x' }).success).toBe(false);
    expect(ThreeWayQuerySchema.safeParse({ fiscal_year: '27' }).success).toBe(false);
    expect(ThreeWayQuerySchema.safeParse({ version_id: [A, B] }).success).toBe(false);
  });
  it('version query needs a version', () => {
    expect(VersionQuerySchema.safeParse({}).success).toBe(false);
    expect(VersionQuerySchema.safeParse({ version_id: [A, A] }).success).toBe(false);
  });
});

describe('PUT assumptions body', () => {
  const ok = { version_id: A, doc: { schemaVersion: 1 }, expected_updated_at: null };
  it('takes a null token (no row yet) or a version-token spelling', () => {
    expect(AssumptionsPutSchema.safeParse(ok).success).toBe(true);
    expect(AssumptionsPutSchema.safeParse({ ...ok, expected_updated_at: '2026-11-13T05:00:00.123456Z' }).success).toBe(true);
  });
  it('refuses a missing token key, a bad token, a non-object doc and unknown keys', () => {
    expect(AssumptionsPutSchema.safeParse({ version_id: A, doc: {} }).success).toBe(false);
    expect(AssumptionsPutSchema.safeParse({ ...ok, expected_updated_at: '2026-02-30T00:00:00Z' }).success).toBe(false);
    expect(AssumptionsPutSchema.safeParse({ ...ok, doc: [1] }).success).toBe(false);
    expect(AssumptionsPutSchema.safeParse({ ...ok, doc: 'x' }).success).toBe(false);
    expect(AssumptionsPutSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe('POST derive body', () => {
  it('a version id only', () => {
    expect(DeriveBodySchema.safeParse({ version_id: A }).success).toBe(true);
    expect(DeriveBodySchema.safeParse({ version_id: A, x: 1 }).success).toBe(false);
  });
});

describe('GET compare query', () => {
  it('1 to 3 comma-separated UUIDs', () => {
    expect(CompareQuerySchema.parse({ version_ids: A }).version_ids).toEqual([A]);
    expect(CompareQuerySchema.parse({ version_ids: `${A}, ${B},${C}` }).version_ids).toEqual([A, B, C]);
  });
  it('refuses none, four, a bad id and a repeated key', () => {
    expect(CompareQuerySchema.safeParse({ version_ids: '' }).success).toBe(false);
    expect(CompareQuerySchema.safeParse({ version_ids: [A, B, C, D].join(',') }).success).toBe(false);
    expect(CompareQuerySchema.safeParse({ version_ids: `${A},nope` }).success).toBe(false);
    expect(CompareQuerySchema.safeParse({ version_ids: [A, B] }).success).toBe(false);
  });
});
