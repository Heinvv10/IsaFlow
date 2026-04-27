/**
 * Unit tests for parseSupplierInvoiceFilters.
 *
 * Pure function with no DB / side-effects, so tests are direct calls with
 * different query-shape inputs.
 */

import { describe, it, expect } from 'vitest';
import { parseSupplierInvoiceFilters } from '@/modules/accounting/services/ap/supplierInvoiceFilterParams';

const ok = <T>(result: { ok: true; filters: T } | { ok: false }): T => {
  if (!result.ok) throw new Error('expected ok=true result');
  return result.filters;
};

describe('parseSupplierInvoiceFilters', () => {
  it('returns empty filters for an empty query object', () => {
    const f = ok(parseSupplierInvoiceFilters({}));
    expect(f.status).toBeUndefined();
    expect(f.supplierId).toBeUndefined();
    expect(f.search).toBeUndefined();
    expect(f.sort).toBeUndefined();
    expect(f.sortOrder).toBeUndefined();
  });

  it('accepts a valid status enum value', () => {
    const f = ok(parseSupplierInvoiceFilters({ status: 'approved' }));
    expect(f.status).toBe('approved');
  });

  it('rejects an unknown status', () => {
    const r = parseSupplierInvoiceFilters({ status: 'definitely-not-real' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid status/);
  });

  it('rejects an unknown match_status', () => {
    const r = parseSupplierInvoiceFilters({ match_status: 'maybe' });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown sort key', () => {
    const r = parseSupplierInvoiceFilters({ sort: 'malicious; DROP TABLE x;' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid sort/);
  });

  it('accepts only "asc" or "desc" for sort_order', () => {
    expect(ok(parseSupplierInvoiceFilters({ sort_order: 'asc' })).sortOrder).toBe('asc');
    expect(ok(parseSupplierInvoiceFilters({ sort_order: 'desc' })).sortOrder).toBe('desc');
    expect(ok(parseSupplierInvoiceFilters({ sort_order: 'sideways' })).sortOrder).toBeUndefined();
  });

  it('accepts a UUID supplier_id', () => {
    const f = ok(parseSupplierInvoiceFilters({ supplier_id: '4a159669-2f50-46b5-a7b8-2e94dab3d495' }));
    expect(f.supplierId).toBe('4a159669-2f50-46b5-a7b8-2e94dab3d495');
  });

  it('rejects a non-UUID supplier_id with 400 instead of letting it reach Postgres', () => {
    const r = parseSupplierInvoiceFilters({ supplier_id: '../etc/passwd' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/supplier_id/);
  });

  it('drops non-ISO date strings (returns undefined, not an error)', () => {
    const f = ok(parseSupplierInvoiceFilters({ from_date: '01/15/2026', to_date: 'yesterday' }));
    expect(f.fromDate).toBeUndefined();
    expect(f.toDate).toBeUndefined();
  });

  it('keeps ISO-format date strings', () => {
    const f = ok(parseSupplierInvoiceFilters({ from_date: '2025-05-28', to_date: '2026-04-25' }));
    expect(f.fromDate).toBe('2025-05-28');
    expect(f.toDate).toBe('2026-04-25');
  });

  it('coerces numeric query strings to numbers', () => {
    const f = ok(parseSupplierInvoiceFilters({
      from_amount: '100', to_amount: '5000',
      from_balance: '0', to_balance: '999',
    }));
    expect(f.fromAmount).toBe(100);
    expect(f.toAmount).toBe(5000);
    expect(f.fromBalance).toBe(0);
    expect(f.toBalance).toBe(999);
  });

  it('drops non-numeric values silently (no parse error)', () => {
    const f = ok(parseSupplierInvoiceFilters({ from_amount: 'cheese' }));
    expect(f.fromAmount).toBeUndefined();
  });

  it('caps limit at 200 even if a larger value is requested', () => {
    const f = ok(parseSupplierInvoiceFilters({ limit: '5000' }));
    expect(f.limit).toBe(200);
  });

  it('rejects negative offset by dropping it', () => {
    const f = ok(parseSupplierInvoiceFilters({ offset: '-50' }));
    expect(f.offset).toBeUndefined();
  });

  it('passes search and trims downstream (whitespace not stripped here)', () => {
    const f = ok(parseSupplierInvoiceFilters({ search: 'INV005388' }));
    expect(f.search).toBe('INV005388');
  });

  // --- strict-boolean filter parser ---

  describe('missing_document strict-boolean', () => {
    it('rejects an invalid value and returns ok=false with a descriptive error', () => {
      const r = parseSupplierInvoiceFilters({ missing_document: 'maybe' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Invalid missing_document/i);
    });

    it('sets missingDocument=false when the param is absent', () => {
      const f = ok(parseSupplierInvoiceFilters({}));
      expect(f.missingDocument).toBe(false);
    });
  });

  describe('possible_duplicate strict-boolean', () => {
    it("accepts 'true' and sets possibleDuplicate=true", () => {
      const f = ok(parseSupplierInvoiceFilters({ possible_duplicate: 'true' }));
      expect(f.possibleDuplicate).toBe(true);
    });

    it("accepts '1' and sets possibleDuplicate=true", () => {
      const f = ok(parseSupplierInvoiceFilters({ possible_duplicate: '1' }));
      expect(f.possibleDuplicate).toBe(true);
    });

    it("accepts '0' and sets possibleDuplicate=false", () => {
      const f = ok(parseSupplierInvoiceFilters({ possible_duplicate: '0' }));
      expect(f.possibleDuplicate).toBe(false);
    });

    it("accepts 'false' and sets possibleDuplicate=false", () => {
      const f = ok(parseSupplierInvoiceFilters({ possible_duplicate: 'false' }));
      expect(f.possibleDuplicate).toBe(false);
    });

    it('sets possibleDuplicate=false when the param is absent', () => {
      const f = ok(parseSupplierInvoiceFilters({}));
      expect(f.possibleDuplicate).toBe(false);
    });
  });

  describe('due_this_week strict-boolean', () => {
    it('rejects an invalid value and returns ok=false', () => {
      const r = parseSupplierInvoiceFilters({ due_this_week: 'yes' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Invalid due_this_week/i);
    });
  });

  describe('pay_run_ready strict-boolean', () => {
    it('rejects an invalid value and returns ok=false', () => {
      const r = parseSupplierInvoiceFilters({ pay_run_ready: 'on' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Invalid pay_run_ready/i);
    });
  });
});
