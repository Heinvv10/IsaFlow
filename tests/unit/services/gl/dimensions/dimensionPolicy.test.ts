/**
 * Dimensions Phase 1 — the matrix rules the ledger enforces (brief §5.3):
 * settlements carry no dimensions; a COS line with no project WARNS, and blocks
 * only where companies.require_project_on_cos is set.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import {
  applyJournalDimensionPolicy, assertDocumentDimensions, assertNoSettlementDimensions, checkCosProjects,
  cosProjectWarnings, isControlSubtype,
} from '@/modules/accounting/services/gl/dimensions/dimensionPolicy';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const COS = '22222222-2222-4222-8222-222222222222';
const OPEX = '33333333-3333-4333-8333-333333333333';
const CC2 = '44444444-4444-4444-8444-444444444444';

describe('settlements carry no dimensions', () => {
  it.each(['auto_payment', 'auto_supplier_payment', 'auto_batch_payment', 'auto_bank_transfer', 'auto_vat_submission'] as const)(
    'refuses explicit dimensions on a %s journal', (source) => {
      expect(() => assertNoSettlementDimensions(source, [{ cc2Id: CC2 }])).toThrow(/carries no CC1\/CC2\/BU/);
    },
  );
  it('allows a settlement with none, and dimensions on a cost journal', () => {
    expect(() => assertNoSettlementDimensions('auto_supplier_payment', [{}])).not.toThrow();
    expect(() => assertNoSettlementDimensions('auto_bank_recon', [{ cc2Id: CC2 }])).not.toThrow();
  });
  it('the journal-level policy refuses before any query', async () => {
    mockSql.mockReset();
    const err = await applyJournalDimensionPolicy(COMPANY, 'auto_payment', [
      { glAccountId: COS, debit: 1, credit: 0, buId: 'bu' },
    ]).catch((e: unknown) => e);
    expect(isDimensionRefusal(err)).toBe(true);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('isControlSubtype', () => {
  it.each(['bank', 'receivable', 'accounts_payable', 'vat_input', 'vat_output', 'payroll_liability'])('%s is a control', (s) => {
    expect(isControlSubtype(s)).toBe(true);
  });
  it.each(['cost_of_sales', 'operating_expense', 'long_term_liability', null])('%s is not', (s) => {
    expect(isControlSubtype(s)).toBe(false);
  });
});

describe('COS line with no project', () => {
  beforeEach(() => mockSql.mockReset());

  it('sends no query when every line already names a project', async () => {
    expect(await checkCosProjects(COMPANY, [{ glAccountId: COS, cc2Id: CC2 }])).toEqual({ missing: [], enforced: false });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('WARNS (not blocks) by default, naming only the COS line', async () => {
    mockSql.mockResolvedValueOnce([{ enforced: false, cos_ids: [COS] }]);
    const warnings = await cosProjectWarnings(COMPANY, [
      { glAccountId: OPEX }, { glAccountId: COS },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^lines\[1\]: cost-of-sales line with no project/);
  });

  it('BLOCKS when the company requires a project on COS', async () => {
    mockSql.mockResolvedValueOnce([{ enforced: true, cos_ids: [COS] }]);
    const err = await cosProjectWarnings(COMPANY, [{ glAccountId: COS }]).catch((e: unknown) => e);
    expect(isDimensionRefusal(err)).toBe(true);
    expect((err as Error).message).toMatch(/must name a project \(CC2\)/);
  });

  it('a COS line WITH a project is neither warned nor blocked, even when enforced', async () => {
    mockSql.mockResolvedValueOnce([{ enforced: true, cos_ids: [COS] }]);
    expect(await cosProjectWarnings(COMPANY, [{ glAccountId: COS, cc2Id: CC2 }, { glAccountId: OPEX }])).toEqual([]);
  });
});

describe('assertDocumentDimensions', () => {
  beforeEach(() => mockSql.mockReset());
  it('sends no query when nothing is named, and turns a slot refusal into a DimensionRefusal', async () => {
    await assertDocumentDimensions(COMPANY, [{}]);
    expect(mockSql).not.toHaveBeenCalled();
    mockSql.mockResolvedValueOnce([{ id: CC2, cc_type: 'cc1', is_active: true }]);
    const err = await assertDocumentDimensions(COMPANY, [{ cc2Id: CC2 }]).catch((e: unknown) => e);
    expect(isDimensionRefusal(err)).toBe(true);
  });
});
