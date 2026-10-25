/**
 * listItems: the search term is user text bound into ILIKE, so a literal %, _ or \ must match literally
 * (PostgreSQL's default ILIKE escape is backslash), and `limit` replaces the fixed 500 for the picker.
 * No DB fixture: asserts the bound parameters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(async () => []), { unsafe: (s: string) => s });
  return { sql };
});
vi.mock('@/lib/neon', () => ({ sql: mocks.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/numberLock', () => ({ ITEM_CODE_SEED: 1, takeCompanyNumberLock: vi.fn() }));

import { listItems } from '@/modules/accounting/services/items/itemService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '33333333-3333-4333-8333-333333333333';
const bound = () => (mocks.sql.mock.calls[0] as unknown[]).slice(1);

describe('listItems search escaping and limit', () => {
  beforeEach(() => mocks.sql.mockClear());

  it('escapes %, _ and backslash so they match literally (search alone)', async () => {
    await listItems(COMPANY, { q: '50%_off\\x' });
    expect(bound()).toContain('%50\\%\\_off\\\\x%');
  });

  it('escapes them in the search + category branch too', async () => {
    await listItems(COMPANY, { q: '50%', category_id: CATEGORY });
    expect(bound()).toContain('%50\\%%');
  });

  it('leaves an ordinary term as a plain contains-pattern', async () => {
    await listItems(COMPANY, { q: 'widget' });
    expect(bound()).toContain('%widget%');
  });

  it('binds the limit in every branch, defaulting to the old 500', async () => {
    for (const filters of [{}, { q: 'a' }, { category_id: CATEGORY }, { q: 'a', category_id: CATEGORY }]) {
      mocks.sql.mockClear();
      await listItems(COMPANY, { ...filters, limit: 20 });
      expect(bound()).toContain(20);
      mocks.sql.mockClear();
      await listItems(COMPANY, filters);
      expect(bound()).toContain(500);
    }
  });

  it('caps the limit at 500 and ignores a non-positive one', async () => {
    await listItems(COMPANY, { limit: 9999 });
    expect(bound()).toContain(500);
    mocks.sql.mockClear();
    await listItems(COMPANY, { limit: 0 });
    expect(bound()).toContain(500);
  });
});
