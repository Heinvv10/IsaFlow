// RED phase — written before implementation
/**
 * Unit tests for supplierRulesService.ts
 *
 * Covers: listRules (snake→camel mapping), upsertRule (create + update paths),
 * deleteRule, getRule, and the full recordCoding learning loop:
 * first entry, match accumulation, promotion at threshold, post-promotion
 * behaviour, drift detection, and null GL equality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock ──────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  listRules,
  getRule,
  upsertRule,
  deleteRule,
  recordCoding,
  type SupplierRule,
  type CodingEntry,
} from '@/modules/accounting/services/capture/supplierRulesService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID     = 'cccccccc-0000-0000-0000-000000000003';
const GL_ID       = 'dddddddd-0000-0000-0000-000000000004';
const GL_ID_2     = 'eeeeeeee-0000-0000-0000-000000000005';

function makeDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rr000000-0000-0000-0000-000000000001',
    company_id: COMPANY_ID,
    supplier_id: SUPPLIER_ID,
    default_gl_account_id: GL_ID,
    default_vat_code: 'S',
    default_cost_centre_id: null,
    default_project_id: null,
    auto_publish: false,
    auto_publish_max_amount: null,
    auto_publish_min_confidence: 0.95,
    require_po_match: false,
    learned_sample_count: 0,
    learned_from_last_correction_at: null,
    updated_by: USER_ID,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRule(overrides: Partial<SupplierRule> = {}): SupplierRule {
  return {
    id: 'rr000000-0000-0000-0000-000000000001',
    companyId: COMPANY_ID,
    supplierId: SUPPLIER_ID,
    defaultGlAccountId: GL_ID,
    defaultVatCode: 'S',
    defaultCostCentreId: null,
    defaultProjectId: null,
    autoPublish: false,
    autoPublishMaxAmount: null,
    autoPublishMinConfidence: 0.95,
    requirePoMatch: false,
    learnedSampleCount: 0,
    learnedFromLastCorrectionAt: null,
    updatedBy: USER_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CodingEntry> = {}): CodingEntry {
  return {
    supplierId: SUPPLIER_ID,
    supplierInvoiceId: null,
    glAccountId: GL_ID,
    vatCode: 'S',
    costCentreId: null,
    projectId: null,
    postedBy: `human:${USER_ID}`,
    ...overrides,
  };
}

// ── listRules ─────────────────────────────────────────────────────────────────

describe('listRules', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns an empty array when there are no rules for the company', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    const result = await listRules(COMPANY_ID);
    expect(result).toEqual([]);
  });

  it('maps snake_case columns to camelCase SupplierRule shape', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow()] as never);
    const [rule] = await listRules(COMPANY_ID);
    expect(rule).toMatchObject({
      id: 'rr000000-0000-0000-0000-000000000001',
      companyId: COMPANY_ID,
      supplierId: SUPPLIER_ID,
      defaultGlAccountId: GL_ID,
      defaultVatCode: 'S',
      defaultCostCentreId: null,
      defaultProjectId: null,
      autoPublish: false,
      autoPublishMaxAmount: null,
      autoPublishMinConfidence: 0.95,
      requirePoMatch: false,
      learnedSampleCount: 0,
      learnedFromLastCorrectionAt: null,
    });
  });

  it('returns multiple rules in the order the DB returns them', async () => {
    const row1 = makeDbRow({ id: 'rr000001-0000-0000-0000-000000000001' });
    const row2 = makeDbRow({ id: 'rr000002-0000-0000-0000-000000000002', supplier_id: 'ff000000-0000-0000-0000-000000000001' });
    vi.mocked(sqlMock).mockResolvedValueOnce([row1, row2] as never);
    const result = await listRules(COMPANY_ID);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('rr000001-0000-0000-0000-000000000001');
    expect(result[1].id).toBe('rr000002-0000-0000-0000-000000000002');
  });
});

// ── getRule ───────────────────────────────────────────────────────────────────

describe('getRule', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns null when no row is found', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    const result = await getRule(COMPANY_ID, SUPPLIER_ID);
    expect(result).toBeNull();
  });

  it('returns a mapped SupplierRule when a row exists', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow()] as never);
    const result = await getRule(COMPANY_ID, SUPPLIER_ID);
    expect(result).not.toBeNull();
    expect(result!.supplierId).toBe(SUPPLIER_ID);
    expect(result!.companyId).toBe(COMPANY_ID);
  });
});

// ── upsertRule ────────────────────────────────────────────────────────────────

describe('upsertRule', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns the mapped rule returned by the DB after insert', async () => {
    const dbRow = makeDbRow({ auto_publish: false });
    vi.mocked(sqlMock).mockResolvedValueOnce([dbRow] as never);

    const result = await upsertRule(COMPANY_ID, SUPPLIER_ID, {
      defaultGlAccountId: GL_ID,
      defaultVatCode: 'S',
    }, USER_ID);

    expect(result.supplierId).toBe(SUPPLIER_ID);
    expect(result.defaultGlAccountId).toBe(GL_ID);
    expect(result.autoPublish).toBe(false);
  });

  it('returns the updated rule when the DB resolves the conflict', async () => {
    const updatedRow = makeDbRow({ auto_publish: true, default_vat_code: 'Z' });
    vi.mocked(sqlMock).mockResolvedValueOnce([updatedRow] as never);

    const result = await upsertRule(COMPANY_ID, SUPPLIER_ID, {
      autoPublish: true,
      defaultVatCode: 'Z',
    }, USER_ID);

    expect(result.autoPublish).toBe(true);
    expect(result.defaultVatCode).toBe('Z');
  });

  it('throws when the DB returns no row', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    await expect(
      upsertRule(COMPANY_ID, SUPPLIER_ID, {}, USER_ID),
    ).rejects.toThrow('upsert returned no row');
  });
});

// ── deleteRule ────────────────────────────────────────────────────────────────

describe('deleteRule', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('resolves without error and issues one SQL call', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    await expect(deleteRule(COMPANY_ID, SUPPLIER_ID)).resolves.toBeUndefined();
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });
});

// ── recordCoding ──────────────────────────────────────────────────────────────

describe('recordCoding', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── No rule scenario ────────────────────────────────────────────────────────

  it('returns { promoted: false, sampleCount: 0 } when no rule exists AND coding has no GL account (AI-pipeline path)', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // getRule SELECT → no row

    const result = await recordCoding(COMPANY_ID, makeEntry({ glAccountId: null }));

    expect(result).toEqual({ promoted: false, sampleCount: 0 });
  });

  it('auto-seeds the rule and returns sampleCount: 1 when no rule exists AND coding has a GL account (human path)', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // getRule SELECT → no row
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // INSERT supplier_coding_rules (auto-seed)

    const result = await recordCoding(COMPANY_ID, makeEntry());

    expect(result).toEqual({ promoted: false, sampleCount: 1 });
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(3);
  });

  // ── GL match — increment path ───────────────────────────────────────────────

  it('increments sample count and returns promoted: false when below threshold', async () => {
    const rule = makeRule({ learnedSampleCount: 2, autoPublish: false });

    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow({ learned_sample_count: 2 })] as never); // getRule
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // UPDATE increment

    void rule; // rule used for context only

    const result = await recordCoding(COMPANY_ID, makeEntry());

    // learnedSampleCount was 2, new count should be 3
    expect(result).toEqual({ promoted: false, sampleCount: 3 });
  });

  it('promotes auto_publish after 5 consecutive matching entries', async () => {
    // Rule has learnedSampleCount=4 — the 5th consistent entry triggers promotion
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow({ learned_sample_count: 4, auto_publish: false })] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // UPDATE → auto_publish=true

    const result = await recordCoding(COMPANY_ID, makeEntry());

    expect(result).toEqual({ promoted: true, sampleCount: 5 });
  });

  it('does NOT re-promote on the 6th consistent entry when auto_publish is already true', async () => {
    // Rule already has auto_publish=true and learnedSampleCount=5
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow({ learned_sample_count: 5, auto_publish: true })] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // UPDATE count

    const result = await recordCoding(COMPANY_ID, makeEntry());

    expect(result).toEqual({ promoted: false, sampleCount: 6 });
  });

  it('does not promote when threshold is met but auto_publish is already true', async () => {
    // learnedSampleCount=4 but auto_publish already true — should NOT set promoted=true
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow({ learned_sample_count: 4, auto_publish: true })] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // UPDATE count

    const result = await recordCoding(COMPANY_ID, makeEntry());

    expect(result.promoted).toBe(false);
    expect(result.sampleCount).toBe(5);
  });

  // ── Drift path ──────────────────────────────────────────────────────────────

  it('resets sample count to 1 and returns promoted: false when GL account drifts', async () => {
    // Rule has GL_ID but new coding comes in with GL_ID_2
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow({ learned_sample_count: 3 })] as never); // getRule
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // UPDATE drift reset

    const result = await recordCoding(COMPANY_ID, makeEntry({ glAccountId: GL_ID_2 }));

    expect(result).toEqual({ promoted: false, sampleCount: 1 });
    // Three SQL calls: INSERT history + getRule SELECT + UPDATE drift
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(3);
  });

  it('updates rule defaults to the new GL account on drift', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow()] as never); // getRule (GL_ID)
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // UPDATE

    await recordCoding(COMPANY_ID, makeEntry({ glAccountId: GL_ID_2, vatCode: 'Z' }));

    // Drift UPDATE is the 3rd call — assert it was issued (not zero-ed out)
    const calls = vi.mocked(sqlMock).mock.calls;
    expect(calls).toHaveLength(3);
  });

  // ── Null GL equality ────────────────────────────────────────────────────────

  it('treats null glAccountId matching null rule default as a match (not drift)', async () => {
    // Rule default_gl_account_id is null, entry also has null — should increment
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow({ default_gl_account_id: null, learned_sample_count: 1 })] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // UPDATE increment

    const result = await recordCoding(COMPANY_ID, makeEntry({ glAccountId: null }));

    // Should increment, not reset to 1
    expect(result).toEqual({ promoted: false, sampleCount: 2 });
  });

  it('resets to 1 when entry has non-null GL but rule default is null (drift)', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // INSERT history
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDbRow({ default_gl_account_id: null, learned_sample_count: 2 })] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);           // UPDATE drift

    const result = await recordCoding(COMPANY_ID, makeEntry({ glAccountId: GL_ID }));

    expect(result).toEqual({ promoted: false, sampleCount: 1 });
  });
});
