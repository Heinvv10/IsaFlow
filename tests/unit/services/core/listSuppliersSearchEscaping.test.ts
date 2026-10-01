/**
 * listSuppliers' search term is user / OCR text bound into ILIKE: a literal %, _ or \
 * must match literally, not as a wildcard. No DB fixture here, so this asserts the
 * bound parameter (PostgreSQL's default ILIKE escape is backslash, so `\%` is a literal %).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: mocks.sql, withSavepoint: vi.fn() }));

import { listSuppliers } from '@/modules/accounting/services/core/contactDirectoryService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const patterns = () => mocks.sql.mock.calls.flatMap((c) => (c as unknown[]).slice(1)).filter((v) => typeof v === 'string' && v.startsWith('%'));

describe('listSuppliers search escaping', () => {
  beforeEach(() => { mocks.sql.mockReset(); mocks.sql.mockResolvedValue([{ count: 0 }]); });

  it('escapes %, _ and backslash so they match literally', async () => {
    await listSuppliers(COMPANY, { search: '50%_off\\x' });
    expect(new Set(patterns())).toEqual(new Set(['%50\\%\\_off\\\\x%']));
  });

  it('leaves an ordinary term as a plain contains-pattern', async () => {
    await listSuppliers(COMPANY, { search: ' Acme ' });
    expect(new Set(patterns())).toEqual(new Set(['%Acme%']));
  });
});
