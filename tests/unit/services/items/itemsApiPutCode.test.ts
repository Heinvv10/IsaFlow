/**
 * items API PUT — the item code is stored trimmed (the dupe check and PO-import lookups
 * trim), and a code that is blank after trimming is refused with nothing written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h, withWriteAccess: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/items/itemBundleService', () => ({ expandBundle: vi.fn() }));
vi.mock('@/modules/accounting/services/items/itemService', () => ({
  getItem: vi.fn(), listItems: vi.fn(), createItem: vi.fn(), softDeleteItem: vi.fn(),
  itemExists: vi.fn(async () => true),
  checkCodeDuplicate: vi.fn(async () => false),
  updateItem: vi.fn(async (_c: string, i: unknown) => i),
}));

import { MAX_CODE_LENGTH } from '@/modules/accounting/services/items/itemCatalogTypes';
import { checkCodeDuplicate, createItem, updateItem } from '@/modules/accounting/services/items/itemService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import route from '../../../../pages/api/accounting/items';

const ID = '11111111-1111-4111-8111-111111111111';

async function call(method: string, body: Record<string, unknown>) {
  const res = {
    statusCode: 0, body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader() { /* not needed */ },
  };
  const req = { method, query: {}, body, headers: {}, companyId: 'c1' } as unknown as NextApiRequest;
  await (route as H)(req, res as unknown as NextApiResponse);
  return res;
}

const put = (body: Record<string, unknown>) => call('PUT', body);
const post = (body: Record<string, unknown>) => call('POST', { description: 'Fibre', ...body });

describe('items PUT code', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores and dupe-checks the trimmed code', async () => {
    const res = await put({ id: ID, code: ' FIB-0001 ' });
    expect(res.statusCode).toBe(200);
    expect(checkCodeDuplicate).toHaveBeenCalledWith('c1', 'FIB-0001', ID);
    expect(updateItem).toHaveBeenCalledWith('c1', expect.objectContaining({ id: ID, code: 'FIB-0001' }));
  });

  it('refuses a blank code and writes nothing', async () => {
    const res = await put({ id: ID, code: '   ' });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.body)).toContain('Item code cannot be blank');
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('refuses a code that is not text (null would be stored as "null")', async () => {
    const res = await put({ id: ID, code: null });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.body)).toContain('null is not allowed on update; omit code to keep it');
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('refuses a code over the code limit (the column limit)', async () => {
    const res = await put({ id: ID, code: 'X'.repeat(MAX_CODE_LENGTH + 1) });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.body)).toContain(`at most ${MAX_CODE_LENGTH} characters`);
    expect(updateItem).not.toHaveBeenCalled();
    const ok = await put({ id: ID, code: ` ${'X'.repeat(MAX_CODE_LENGTH)} ` });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses a number code (it would be stored as "123")', async () => {
    const res = await put({ id: ID, code: 123 });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.body)).toContain('Item code must be text');
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('refuses a code another item holds and writes nothing', async () => {
    vi.mocked(checkCodeDuplicate).mockResolvedValueOnce(true);
    const res = await put({ id: ID, code: 'FIB-0001' });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.body)).toContain('already exists');
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('leaves the code out of the update when the body has none', async () => {
    await put({ id: ID, description: 'x' });
    const input = vi.mocked(updateItem).mock.calls[0][1];
    expect('code' in input).toBe(false);
  });
});

describe('items POST code', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(createItem).mockResolvedValue({ id: ID } as never); });

  it('refuses a code that is not text (an object would become "[object Object]")', async () => {
    for (const code of [{ a: 1 }, 123, true, ['X'], 0, false, Number.NaN]) {
      const res = await post({ code });
      expect(res.statusCode).toBe(422);
      expect(JSON.stringify(res.body)).toContain('Item code must be text');
    }
    expect(createItem).not.toHaveBeenCalled();
  });

  it('refuses a code over the code limit (VARCHAR(50) would 500), accepts 50 after trimming', async () => {
    const res = await post({ code: 'X'.repeat(MAX_CODE_LENGTH + 1) });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.body)).toContain(`Item code must be at most ${MAX_CODE_LENGTH} characters`);
    expect(createItem).not.toHaveBeenCalled();
    const ok = await post({ code: ` ${'X'.repeat(MAX_CODE_LENGTH)} ` });
    expect(ok.statusCode).toBe(201);
    expect(createItem).toHaveBeenCalledWith('c1', expect.objectContaining({ code: 'X'.repeat(MAX_CODE_LENGTH) }));
  });

  it('a missing, null or blank code still means auto-generate', async () => {
    for (const code of [undefined, null, '', '   ']) {
      await post({ code });
      expect(vi.mocked(createItem).mock.calls.at(-1)![1].code).toBeUndefined();
    }
    expect(checkCodeDuplicate).not.toHaveBeenCalled();
  });
});
