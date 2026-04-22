// RED phase — written before implementation
/**
 * Unit tests for autoPublishGateService.ts
 *
 * Covers every branch of the decision ladder:
 *   duplicate_blocked → route_review (no rule) → route_review (auto_publish disabled)
 *   → route_review (confidence too low) → route_review (over amount cap)
 *   → route_review (PO match required) → auto_publish
 *
 * Cross-service dependencies are mocked; this service has no direct DB calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/modules/accounting/services/capture/duplicateDetectionService', () => ({
  findDuplicate: vi.fn(),
  computeFingerprint: (...args: unknown[]) => args.map(a => a ?? 'null').join('|'),
}));

vi.mock('@/modules/accounting/services/capture/supplierRulesService', () => ({
  getRule: vi.fn(),
}));

import { decide, type GateOptions } from '@/modules/accounting/services/capture/autoPublishGateService';
import { findDuplicate } from '@/modules/accounting/services/capture/duplicateDetectionService';
import { getRule } from '@/modules/accounting/services/capture/supplierRulesService';
import type { SupplierRule } from '@/modules/accounting/services/capture/supplierRulesService';
import type { DuplicateHit } from '@/modules/accounting/services/capture/duplicateDetectionService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const INVOICE_ID  = 'cccccccc-0000-0000-0000-000000000003';

const BASE_OPTS: GateOptions = {
  companyId: COMPANY_ID,
  supplierId: SUPPLIER_ID,
  invoiceNumber: 'INV-2026-001',
  totalAmount: 1000,
  invoiceDate: '2026-01-15',
  vatNumber: '4150165685',
  extractionConfidence: 0.97,
};

function makeRule(overrides: Partial<SupplierRule> = {}): SupplierRule {
  return {
    id: 'rr000000-0000-0000-0000-000000000001',
    companyId: COMPANY_ID,
    supplierId: SUPPLIER_ID,
    defaultGlAccountId: 'dddddddd-0000-0000-0000-000000000004',
    defaultVatCode: 'S',
    defaultCostCentreId: null,
    defaultProjectId: null,
    autoPublish: true,
    autoPublishMaxAmount: null,
    autoPublishMinConfidence: 0.95,
    requirePoMatch: false,
    learnedSampleCount: 5,
    learnedFromLastCorrectionAt: null,
    updatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDuplicateHit(overrides: Partial<DuplicateHit> = {}): DuplicateHit {
  return {
    supplierInvoiceId: INVOICE_ID,
    invoiceNumber: 'INV-2026-001',
    totalAmount: 1000,
    invoiceDate: '2026-01-15',
    confidence: 1.0,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('decide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no duplicate, no rule
    vi.mocked(findDuplicate).mockResolvedValue(null);
    vi.mocked(getRule).mockResolvedValue(null);
  });

  // ── Step 1: duplicate_blocked ─────────────────────────────────────────────

  it('returns duplicate_blocked when findDuplicate returns a hit', async () => {
    vi.mocked(findDuplicate).mockResolvedValue(makeDuplicateHit());

    const result = await decide(BASE_OPTS);

    expect(result.outcome).toBe('duplicate_blocked');
    if (result.outcome === 'duplicate_blocked') {
      expect(result.hit.supplierInvoiceId).toBe(INVOICE_ID);
      expect(result.hit.confidence).toBe(1.0);
    }
  });

  it('does not call getRule when a duplicate is found', async () => {
    vi.mocked(findDuplicate).mockResolvedValue(makeDuplicateHit());

    await decide(BASE_OPTS);

    expect(vi.mocked(getRule)).not.toHaveBeenCalled();
  });

  it('returns duplicate_blocked even for a fuzzy hit (confidence 0.85)', async () => {
    vi.mocked(findDuplicate).mockResolvedValue(makeDuplicateHit({ confidence: 0.85 }));

    const result = await decide(BASE_OPTS);

    expect(result.outcome).toBe('duplicate_blocked');
  });

  // ── Step 2a: route_review — no rule ──────────────────────────────────────

  it('returns route_review with reason "no rule" when getRule returns null', async () => {
    vi.mocked(getRule).mockResolvedValue(null);

    const result = await decide(BASE_OPTS);

    expect(result.outcome).toBe('route_review');
    if (result.outcome === 'route_review') {
      expect(result.reasons).toContain('no rule');
      expect(result.rule).toBeNull();
    }
  });

  // ── Step 2b: route_review — auto_publish disabled ─────────────────────────

  it('returns route_review with reason "auto_publish disabled" when rule.autoPublish is false', async () => {
    vi.mocked(getRule).mockResolvedValue(makeRule({ autoPublish: false }));

    const result = await decide(BASE_OPTS);

    expect(result.outcome).toBe('route_review');
    if (result.outcome === 'route_review') {
      expect(result.reasons).toContain('auto_publish disabled');
      expect(result.rule).not.toBeNull();
    }
  });

  // ── Step 3: route_review — confidence too low ─────────────────────────────

  it('returns route_review when extractionConfidence is below rule.autoPublishMinConfidence', async () => {
    vi.mocked(getRule).mockResolvedValue(makeRule({ autoPublish: true, autoPublishMinConfidence: 0.95 }));

    const result = await decide({ ...BASE_OPTS, extractionConfidence: 0.80 });

    expect(result.outcome).toBe('route_review');
    if (result.outcome === 'route_review') {
      expect(result.reasons.some(r => r.includes('confidence too low'))).toBe(true);
    }
  });

  it('allows through when extractionConfidence exactly equals autoPublishMinConfidence', async () => {
    vi.mocked(getRule).mockResolvedValue(makeRule({
      autoPublish: true,
      autoPublishMinConfidence: 0.95,
      autoPublishMaxAmount: null,
      requirePoMatch: false,
    }));

    const result = await decide({ ...BASE_OPTS, extractionConfidence: 0.95 });

    // Exactly at threshold is not "below" — should pass through to auto_publish
    expect(result.outcome).toBe('auto_publish');
  });

  // ── Step 4: route_review — over amount cap ────────────────────────────────

  it('returns route_review when totalAmount exceeds autoPublishMaxAmount', async () => {
    vi.mocked(getRule).mockResolvedValue(makeRule({ autoPublishMaxAmount: 500 }));

    const result = await decide({ ...BASE_OPTS, totalAmount: 1000 });

    expect(result.outcome).toBe('route_review');
    if (result.outcome === 'route_review') {
      expect(result.reasons.some(r => r.includes('over amount cap'))).toBe(true);
    }
  });

  it('allows through when totalAmount equals autoPublishMaxAmount', async () => {
    vi.mocked(getRule).mockResolvedValue(makeRule({
      autoPublish: true,
      autoPublishMaxAmount: 1000,
      requirePoMatch: false,
      autoPublishMinConfidence: 0.90,
    }));

    const result = await decide({ ...BASE_OPTS, totalAmount: 1000, extractionConfidence: 0.97 });

    // Equal to cap is not "over" — should pass
    expect(result.outcome).toBe('auto_publish');
  });

  it('ignores amount cap when autoPublishMaxAmount is null', async () => {
    vi.mocked(getRule).mockResolvedValue(makeRule({
      autoPublish: true,
      autoPublishMaxAmount: null,
      requirePoMatch: false,
      autoPublishMinConfidence: 0.90,
    }));

    const result = await decide({ ...BASE_OPTS, totalAmount: 9_999_999, extractionConfidence: 0.97 });

    expect(result.outcome).toBe('auto_publish');
  });

  // ── Step 5: route_review — PO match required ──────────────────────────────

  it('returns route_review with PO reason when requirePoMatch is true', async () => {
    vi.mocked(getRule).mockResolvedValue(makeRule({ requirePoMatch: true }));

    const result = await decide(BASE_OPTS);

    expect(result.outcome).toBe('route_review');
    if (result.outcome === 'route_review') {
      expect(result.reasons.some(r => r.includes('PO match required'))).toBe(true);
    }
  });

  // ── Multiple reasons accumulate ───────────────────────────────────────────

  it('accumulates multiple route_review reasons (low confidence + over cap + PO)', async () => {
    vi.mocked(getRule).mockResolvedValue(makeRule({
      autoPublish: true,
      autoPublishMinConfidence: 0.95,
      autoPublishMaxAmount: 500,
      requirePoMatch: true,
    }));

    const result = await decide({ ...BASE_OPTS, totalAmount: 1000, extractionConfidence: 0.80 });

    expect(result.outcome).toBe('route_review');
    if (result.outcome === 'route_review') {
      expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    }
  });

  // ── Step 6: auto_publish ──────────────────────────────────────────────────

  it('returns auto_publish when all checks pass', async () => {
    vi.mocked(getRule).mockResolvedValue(makeRule({
      autoPublish: true,
      autoPublishMinConfidence: 0.90,
      autoPublishMaxAmount: 5000,
      requirePoMatch: false,
    }));

    const result = await decide({ ...BASE_OPTS, totalAmount: 1000, extractionConfidence: 0.97 });

    expect(result.outcome).toBe('auto_publish');
    if (result.outcome === 'auto_publish') {
      expect(result.reason).toBe('rule satisfied');
      expect(result.rule).not.toBeNull();
      expect(result.rule.supplierId).toBe(SUPPLIER_ID);
    }
  });

  it('attaches the full rule to the auto_publish outcome', async () => {
    const rule = makeRule({ autoPublish: true, autoPublishMinConfidence: 0.80 });
    vi.mocked(getRule).mockResolvedValue(rule);

    const result = await decide({ ...BASE_OPTS, extractionConfidence: 0.99 });

    expect(result.outcome).toBe('auto_publish');
    if (result.outcome === 'auto_publish') {
      expect(result.rule).toEqual(rule);
    }
  });
});
