/**
 * supplierWriteService — auto_allocate_strategy (migration 614).
 *
 * `auto_allocate_strategy` replaces the dead `auto_allocate_payments` boolean
 * as the source of truth for how a supplier payment gets applied. These tests
 * pin: a valid value is accepted and keeps the legacy boolean in sync; an
 * invalid value is refused before it can reach the DB CHECK constraint
 * (`suppliers_auto_allocate_strategy_check`) as an opaque 23514; the
 * deprecated boolean is IGNORED rather than obeyed; and an update that
 * supplies neither leaves both columns untouched via COALESCE.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn().mockResolvedValue([{ id: 'supplier-1', name: 'Test Supplier' }]),
    { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) },
  );
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn() };
});

import { sql } from '@/lib/neon';
import { createSupplier, updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { ContactValidationError } from '@/modules/accounting/services/core/customerWriteService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const SUPPLIER_ID = 'ssssssss-0000-4000-8000-ssssssssssss';

function insertParams(): unknown[] {
  return mockSql.mock.calls[0]!.slice(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([{ id: 'supplier-1', name: 'Test Supplier' }]);
});

describe('createSupplier — auto_allocate_strategy', () => {
  it('writes a valid strategy and keeps the legacy boolean in sync (true)', async () => {
    await createSupplier(COMPANY_ID, { name: 'ACME', autoAllocateStrategy: 'newest' });
    const params = insertParams();
    // Last two VALUES() slots are auto_allocate_strategy, auto_allocate_payments.
    expect(params[params.length - 2]).toBe('newest');
    expect(params[params.length - 1]).toBe(true);
  });

  it('writes "off" and keeps the legacy boolean false when no strategy is given', async () => {
    await createSupplier(COMPANY_ID, { name: 'ACME' });
    const params = insertParams();
    expect(params[params.length - 2]).toBe('off');
    expect(params[params.length - 1]).toBe(false);
  });

  it('rejects an invalid strategy before any SQL runs, naming the allowed values', async () => {
    await expect(
      createSupplier(COMPANY_ID, { name: 'ACME', autoAllocateStrategy: 'weekly' as never }),
    ).rejects.toThrow(ContactValidationError);
    await expect(
      createSupplier(COMPANY_ID, { name: 'ACME', autoAllocateStrategy: 'weekly' as never }),
    ).rejects.toThrow(/off, oldest, newest/);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('IGNORES the deprecated boolean — it can no longer switch anything on', async () => {
    // It used to map true -> 'oldest', which made it the last way a contact
    // could arrive at a strategy nobody chose. Migration 614 refused to carry
    // the old ticks over because nothing ever read them, so nobody consented
    // to cash application by ticking one; obeying the same tick over the wire
    // would re-open the door the migration closed.
    await createSupplier(COMPANY_ID, { name: 'ACME', autoAllocatePayments: true });
    const params = insertParams();
    expect(params[params.length - 2]).toBe('off');
    expect(params[params.length - 1]).toBe(false);
  });

  it('stays off when the deprecated boolean is false', async () => {
    await createSupplier(COMPANY_ID, { name: 'ACME', autoAllocatePayments: false });
    const params = insertParams();
    expect(params[params.length - 2]).toBe('off');
    expect(params[params.length - 1]).toBe(false);
  });

  it('the strategy decides when both are given — the boolean contributes nothing', async () => {
    await createSupplier(COMPANY_ID, {
      name: 'ACME',
      autoAllocateStrategy: 'oldest',
      autoAllocatePayments: false,
    });
    const params = insertParams();
    expect(params[params.length - 2]).toBe('oldest');
    expect(params[params.length - 1]).toBe(true);
  });
});

describe('updateSupplier — auto_allocate_strategy', () => {
  // Position confirmed against the current column order in supplierWriteService.ts:
  // ...category, auto_allocate_strategy, auto_allocate_payments, [updated_at=NOW() has no param], id, company_id
  const STRATEGY_INDEX = 16;
  const BOOLEAN_INDEX = 17;

  it('updates both columns in sync when a valid strategy is supplied', async () => {
    await updateSupplier(COMPANY_ID, SUPPLIER_ID, { autoAllocateStrategy: 'newest' });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBe('newest');
    expect(params[BOOLEAN_INDEX]).toBe(true);
  });

  it('leaves both columns untouched (nulls into COALESCE) when neither is supplied', async () => {
    await updateSupplier(COMPANY_ID, SUPPLIER_ID, { name: 'Renamed' });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBeNull();
    expect(params[BOOLEAN_INDEX]).toBeNull();
  });

  it('rejects an invalid strategy and never issues the UPDATE', async () => {
    await expect(
      updateSupplier(COMPANY_ID, SUPPLIER_ID, { autoAllocateStrategy: 'weekly' as never }),
    ).rejects.toThrow(ContactValidationError);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('ignores the deprecated boolean on update too, leaving both columns alone', async () => {
    // Two nulls into COALESCE: an old caller sending only the boolean changes
    // neither column, rather than switching cash application on for a supplier
    // whose owner never chose it.
    await updateSupplier(COMPANY_ID, SUPPLIER_ID, { autoAllocatePayments: true });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBeNull();
    expect(params[BOOLEAN_INDEX]).toBeNull();
  });
});
