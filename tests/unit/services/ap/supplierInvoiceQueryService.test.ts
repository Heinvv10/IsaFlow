/**
 * Unit tests for supplierInvoiceQueryService + supplierInvoiceWhereBuilder.
 *
 * Focus: cross-tenant duplicate-detection regression guards.
 *
 * Test 1 — INVOICE_COLUMNS EXISTS subquery must include `dup.company_id = si.company_id`
 *   so that invoices from another tenant with the same supplier_id + invoice_number
 *   cannot be treated as duplicates for a different tenant.
 *
 * Test 2 — buildInvoiceWhere's possibleDuplicate EXISTS subquery must use
 *   `dup.company_id = $1::UUID` (the caller's company_id parameter) so the
 *   filter path is equally tenant-scoped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(
    vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([])),
    {
      unsafe: vi.fn((fragment: string, values?: unknown[]) => ({ __fragment: fragment, __values: values ?? [] })),
    },
  );
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  fmtDate: (x: unknown) => String(x),
  DbRow: null,
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { sql } from '@/lib/neon';
import { buildInvoiceWhere } from '@/modules/accounting/services/ap/supplierInvoiceWhereBuilder';

// Read the raw module source so we can string-match the INVOICE_COLUMNS constant.
// This is intentional: the test guards the SQL text itself, not the runtime result.
import * as queryServiceModule from '@/modules/accounting/services/ap/supplierInvoiceQueryService';

const COMPANY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Collect all string arguments passed to sql.unsafe() across all calls.
 * The INVOICE_COLUMNS constant is passed via sql.unsafe(INVOICE_COLUMNS), so
 * the text is in position 0 of each sql.unsafe call.
 */
function collectUnsafeFragments(): string[] {
  return vi.mocked(sql.unsafe).mock.calls.map((args) => String(args[0]));
}

/**
 * Collect all parameter arrays passed to sql.unsafe() across all calls.
 * buildInvoiceWhere passes (text, values[]) so values live in position 1.
 */
function collectUnsafeValues(): unknown[][] {
  return vi.mocked(sql.unsafe).mock.calls.map((args) => (args[1] ?? []) as unknown[]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('INVOICE_COLUMNS — cross-tenant duplicate detection (EXISTS subquery)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('contains dup.company_id = si.company_id in the EXISTS subquery', () => {
    // We need to trigger at least one call to sql.unsafe(INVOICE_COLUMNS).
    // getSupplierInvoices calls it via sql`SELECT ${sql.unsafe(INVOICE_COLUMNS)} ...`
    // We cannot easily introspect the template literal itself, so instead we
    // verify the exported module re-exposes buildInvoiceWhere AND we directly
    // inspect the buildInvoiceWhere output for the INVOICE_COLUMNS constant by
    // checking the module-level string is present in the source module exports.
    //
    // Strategy: call buildInvoiceWhere with possibleDuplicate=true and inspect
    // the sql.unsafe fragment for the duplicate EXISTS clause (WHERE builder path).
    // Then separately assert that the module-level INVOICE_COLUMNS includes the
    // tenant-scoped EXISTS clause via a string match on the sql.unsafe call made
    // inside getSupplierInvoices.

    // Trigger the INVOICE_COLUMNS sql.unsafe call by calling getSupplierInvoices.
    // We set up the mock to return immediately.
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)       // rows query
      .mockResolvedValueOnce([{ cnt: '0' }] as never); // count query

    // We use the exported getSupplierInvoices to trigger sql.unsafe(INVOICE_COLUMNS).
    // (We do not await — we only care about the synchronous sql.unsafe capture.)
    void queryServiceModule.getSupplierInvoices(COMPANY_A);

    // Collect all text fragments passed to sql.unsafe.
    const fragments = collectUnsafeFragments();

    // The INVOICE_COLUMNS string must include the tenant-scoped EXISTS subquery.
    const invoiceColumnsFragment = fragments.find((f) => f.includes('is_possible_duplicate'));
    expect(invoiceColumnsFragment).toBeDefined();
    expect(invoiceColumnsFragment).toContain('dup.company_id = si.company_id');
  });

  it('two tenants with the same supplier_id + invoice_number do not share duplicate scope', () => {
    // This test asserts that the EXISTS clause in INVOICE_COLUMNS is scoped by
    // company_id, meaning COMPANY_A's invoices cannot appear as duplicates of
    // COMPANY_B's invoices. The guard is string-matching the static SQL text.

    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ cnt: '0' }] as never);

    void queryServiceModule.getSupplierInvoices(COMPANY_B);

    const fragments = collectUnsafeFragments();
    const existsFragment = fragments.find((f) => f.includes('is_possible_duplicate'));

    // Must NOT use a bare supplier_id + invoice_number match without company scope.
    expect(existsFragment).not.toMatch(/WHERE\s+dup\.supplier_id/);
    // Must scope the subquery to the same company as the outer row.
    expect(existsFragment).toContain('dup.company_id = si.company_id');
  });
});

describe('buildInvoiceWhere — possibleDuplicate filter tenant scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses dup.company_id = $1::UUID (the caller company param) in the EXISTS subquery', () => {
    buildInvoiceWhere(COMPANY_A, { possibleDuplicate: true });

    const valueGroups = collectUnsafeValues();
    // Find the call where the fragment includes the possibleDuplicate EXISTS clause.
    const callIndex = vi.mocked(sql.unsafe).mock.calls.findIndex(
      (args) => String(args[0]).includes('dup.company_id = $1::UUID'),
    );
    expect(callIndex).toBeGreaterThanOrEqual(0);

    // The values array for that call must have COMPANY_A as $1.
    const values = valueGroups[callIndex];
    expect(values).toBeDefined();
    expect(values![0]).toBe(COMPANY_A);
  });

  it('uses dup.company_id = $1::UUID with a different company_id (COMPANY_B)', () => {
    buildInvoiceWhere(COMPANY_B, { possibleDuplicate: true });

    const callIndex = vi.mocked(sql.unsafe).mock.calls.findIndex(
      (args) => String(args[0]).includes('dup.company_id = $1::UUID'),
    );
    expect(callIndex).toBeGreaterThanOrEqual(0);

    const values = collectUnsafeValues()[callIndex];
    expect(values![0]).toBe(COMPANY_B);
    // COMPANY_A must not appear — no cross-tenant bleed.
    expect(values).not.toContain(COMPANY_A);
  });
});
