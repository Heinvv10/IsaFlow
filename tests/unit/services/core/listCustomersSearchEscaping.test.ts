/**
 * listCustomers' search term is user text bound into ILIKE: a literal %, _ or \ must match literally,
 * not as a wildcard (same helper as listSuppliers). This asserts the bound parameter; the DB-backed
 * counterpart is tests/integration/listCustomersSearchLiteral.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: mocks.sql, withSavepoint: vi.fn() }));

import { listCustomers } from '@/modules/accounting/services/core/contactDirectoryService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const patterns = () => mocks.sql.mock.calls.flatMap((c) => (c as unknown[]).slice(1)).filter((v) => typeof v === 'string' && v.startsWith('%'));

describe('listCustomers search escaping', () => {
  beforeEach(() => { mocks.sql.mockReset(); mocks.sql.mockResolvedValue([]); });

  it('escapes %, _ and backslash so they match literally', async () => {
    await listCustomers(COMPANY, '50%_off\\x');
    expect(new Set(patterns())).toEqual(new Set(['%50\\%\\_off\\\\x%']));
  });

  it('leaves an ordinary term as a plain contains-pattern', async () => {
    await listCustomers(COMPANY, ' Acme ');
    expect(new Set(patterns())).toEqual(new Set(['%Acme%']));
  });
});
