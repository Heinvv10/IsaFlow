/**
 * generateVAT201 swallows source-query failures (warn + empty) so the VAT201
 * page still renders. Refinement from PR #158 review: the swallow must be
 * VISIBLE — box totals computed from missing sources are reported via
 * degradedSources so downstream consumers (VAT exceptions recon) can warn
 * instead of silently showing VAT201=0 vs a full GL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';

function impl(failing: string[]) {
  return async (strings: readonly string[]) => {
    const q = strings.join('?');
    for (const f of failing) {
      if (q.includes(f)) throw new Error(`relation "${f}" does not exist`);
    }
    return [];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(impl([]));
});

describe('generateVAT201 degraded sources', () => {
  it('reports no degradation when all source queries succeed', async () => {
    const data = await generateVAT201('co-1', '2026-01-01', '2026-02-28');
    expect(data.degradedSources).toEqual([]);
  });

  it('flags customer_invoices when the output-side query fails', async () => {
    sqlMock.mockImplementation(impl(['FROM customer_invoices ci']));
    const data = await generateVAT201('co-1', '2026-01-01', '2026-02-28');
    expect(data.degradedSources).toContain('customer_invoices');
    expect(data.field5_outputVAT).toBe(0);
  });

  it('flags supplier_invoices and supplier_invoice_items independently', async () => {
    sqlMock.mockImplementation(impl(['FROM supplier_invoices si', 'FROM supplier_invoice_items sii']));
    const data = await generateVAT201('co-1', '2026-01-01', '2026-02-28');
    expect(data.degradedSources).toContain('supplier_invoices');
    expect(data.degradedSources).toContain('supplier_invoice_items');
  });
});
