/**
 * Unit tests for dunningOverridesService — PRD-06 Phase 5 follow-up.
 *
 * Covers:
 *   1. getOverride returns null when no row
 *   2. getOverride returns the row when present
 *   3. setOverride upserts with suppress_dunning
 *   4. setOverride validates template_id_override belongs to company
 *   5. setOverride allows clearing template_id_override by passing null
 *   6. deleteOverride returns true when a row was deleted, false when none
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(sqlMock)),
  };
});

import { sql } from '@/lib/neon';
import { ArRequestError } from '@/modules/accounting/services/ar/arErrors';
import {
  getOverride,
  setOverride,
  deleteOverride,
} from '@/modules/accounting/services/ar/dunningOverridesService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CUSTOMER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TEMPLATE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOverride', () => {
  it('returns null when no row exists', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getOverride(COMPANY_ID, CUSTOMER_ID);
    expect(result).toBeNull();
  });

  it('returns the override row when present', async () => {
    mockSql.mockResolvedValueOnce([{
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      suppress_dunning: true,
      template_id_override: null,
      note: null,
      created_at: '2026-04-24T00:00:00Z',
      updated_at: '2026-04-24T00:00:00Z',
    }]);
    const result = await getOverride(COMPANY_ID, CUSTOMER_ID);
    expect(result?.suppress_dunning).toBe(true);
  });
});

describe('setOverride', () => {
  it('upserts with suppress_dunning=true', async () => {
    mockSql.mockResolvedValueOnce([]);                              // getOverride → no existing
    mockSql.mockResolvedValueOnce([{                                // upsert RETURNING
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      suppress_dunning: true,
      template_id_override: null,
      note: null,
      created_at: '2026-04-24T00:00:00Z',
      updated_at: '2026-04-24T00:00:00Z',
    }]);
    const result = await setOverride(COMPANY_ID, CUSTOMER_ID, { suppress_dunning: true });
    expect(result.suppress_dunning).toBe(true);
    expect(result.template_id_override).toBeNull();
  });

  it('validates template_id_override belongs to this company', async () => {
    mockSql.mockResolvedValueOnce([]);   // getOverride → none
    mockSql.mockResolvedValueOnce([]);   // template existence check → empty → reject
    await expect(
      setOverride(COMPANY_ID, CUSTOMER_ID, { template_id_override: TEMPLATE_ID }),
    ).rejects.toThrow(/Template .* not found/);
  });

  // Round-5 LOW-1: the route used to read this refusal off the message text and
  // fall back to a catch-all 400 for everything else, which withAuth COMMITs.
  // The refusal must be TYPED so the route can tell it from a PG error.
  it('raises the missing template as a typed 404 ArRequestError', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    const thrown = await setOverride(COMPANY_ID, CUSTOMER_ID, {
      template_id_override: TEMPLATE_ID,
    }).then(() => null, (e: unknown) => e);

    expect(thrown).toBeInstanceOf(ArRequestError);
    expect((thrown as ArRequestError).status).toBe(404);
    expect((thrown as ArRequestError).code).toBe('DUNNING_TEMPLATE_NOT_FOUND');
  });

  it('allows clearing template_id_override by passing null', async () => {
    mockSql.mockResolvedValueOnce([{                                // getOverride → existing with override set
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      suppress_dunning: false,
      template_id_override: TEMPLATE_ID,
      note: null,
      created_at: '2026-04-24T00:00:00Z',
      updated_at: '2026-04-24T00:00:00Z',
    }]);
    mockSql.mockResolvedValueOnce([{                                // upsert RETURNING
      company_id: COMPANY_ID,
      customer_id: CUSTOMER_ID,
      suppress_dunning: false,
      template_id_override: null,
      note: null,
      created_at: '2026-04-24T00:00:00Z',
      updated_at: '2026-04-24T00:00:00Z',
    }]);
    const result = await setOverride(COMPANY_ID, CUSTOMER_ID, { template_id_override: null });
    expect(result.template_id_override).toBeNull();
  });
});

describe('deleteOverride', () => {
  it('returns true when a row was deleted', async () => {
    mockSql.mockResolvedValueOnce([{ customer_id: CUSTOMER_ID }]);
    expect(await deleteOverride(COMPANY_ID, CUSTOMER_ID)).toBe(true);
  });

  it('returns false when no row existed', async () => {
    mockSql.mockResolvedValueOnce([]);
    expect(await deleteOverride(COMPANY_ID, CUSTOMER_ID)).toBe(false);
  });
});
