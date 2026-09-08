/**
 * customerWriteService — auto_allocate_strategy (migration 614).
 *
 * `auto_allocate_strategy` replaces the dead `auto_allocate_receipts` boolean
 * as the source of truth for how a customer receipt gets applied. Mirrors
 * supplierWriteAutoAllocateStrategy.test.ts: a valid value is accepted and
 * keeps the legacy boolean in sync; an invalid value is refused before it can
 * reach the DB CHECK constraint (`customers_auto_allocate_strategy_check`) as
 * an opaque 23514; the deprecated boolean still works for an old caller; and
 * an update that supplies neither leaves both columns untouched via COALESCE.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn().mockResolvedValue([{ id: 'customer-1', name: 'Test Customer' }]),
    { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) },
  );
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn() };
});

import { sql } from '@/lib/neon';
import {
  createCustomer,
  updateCustomer,
  ContactValidationError,
} from '@/modules/accounting/services/core/customerWriteService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const CUSTOMER_ID = 'uuuuuuuu-0000-4000-8000-uuuuuuuuuuuu';

function insertParams(): unknown[] {
  return mockSql.mock.calls[0]!.slice(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([{ id: 'customer-1', name: 'Test Customer' }]);
});

describe('createCustomer — auto_allocate_strategy', () => {
  // Position confirmed against the current column order in customerWriteService.ts.
  const STRATEGY_INDEX = 22;
  const BOOLEAN_INDEX = 23;

  it('writes a valid strategy and keeps the legacy boolean in sync (true)', async () => {
    await createCustomer(COMPANY_ID, { name: 'Acme', autoAllocateStrategy: 'newest' });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBe('newest');
    expect(params[BOOLEAN_INDEX]).toBe(true);
  });

  it('writes "off" and keeps the legacy boolean false when no strategy is given', async () => {
    await createCustomer(COMPANY_ID, { name: 'Acme' });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBe('off');
    expect(params[BOOLEAN_INDEX]).toBe(false);
  });

  it('rejects an invalid strategy before any SQL runs, naming the allowed values', async () => {
    await expect(
      createCustomer(COMPANY_ID, { name: 'Acme', autoAllocateStrategy: 'weekly' as never }),
    ).rejects.toThrow(ContactValidationError);
    await expect(
      createCustomer(COMPANY_ID, { name: 'Acme', autoAllocateStrategy: 'weekly' as never }),
    ).rejects.toThrow(/off, oldest, newest/);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('maps the deprecated boolean true -> oldest when autoAllocateStrategy is absent', async () => {
    await createCustomer(COMPANY_ID, { name: 'Acme', autoAllocateReceipts: true });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBe('oldest');
    expect(params[BOOLEAN_INDEX]).toBe(true);
  });

  it('maps the deprecated boolean false -> off', async () => {
    await createCustomer(COMPANY_ID, { name: 'Acme', autoAllocateReceipts: false });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBe('off');
    expect(params[BOOLEAN_INDEX]).toBe(false);
  });

  it('autoAllocateStrategy wins over the deprecated boolean when both are given', async () => {
    await createCustomer(COMPANY_ID, {
      name: 'Acme',
      autoAllocateStrategy: 'oldest',
      autoAllocateReceipts: false,
    });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBe('oldest');
    expect(params[BOOLEAN_INDEX]).toBe(true);
  });
});

describe('updateCustomer — auto_allocate_strategy', () => {
  const STRATEGY_INDEX = 22;
  const BOOLEAN_INDEX = 23;

  it('updates both columns in sync when a valid strategy is supplied', async () => {
    await updateCustomer(COMPANY_ID, CUSTOMER_ID, { autoAllocateStrategy: 'newest' });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBe('newest');
    expect(params[BOOLEAN_INDEX]).toBe(true);
  });

  it('leaves both columns untouched (nulls into COALESCE) when neither is supplied', async () => {
    await updateCustomer(COMPANY_ID, CUSTOMER_ID, { name: 'Renamed' });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBeNull();
    expect(params[BOOLEAN_INDEX]).toBeNull();
  });

  it('rejects an invalid strategy and never issues the UPDATE', async () => {
    await expect(
      updateCustomer(COMPANY_ID, CUSTOMER_ID, { autoAllocateStrategy: 'weekly' as never }),
    ).rejects.toThrow(ContactValidationError);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('maps the deprecated boolean on update too', async () => {
    await updateCustomer(COMPANY_ID, CUSTOMER_ID, { autoAllocateReceipts: true });
    const params = insertParams();
    expect(params[STRATEGY_INDEX]).toBe('oldest');
    expect(params[BOOLEAN_INDEX]).toBe(true);
  });
});
