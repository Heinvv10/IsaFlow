/**
 * A-I1 — a bank-feed connection's `config` carries only `{ bankId: 'absa' }`.
 * The route rejects anything else (a user pasting bank credentials into
 * `config` must never reach the JSONB column), and the service refuses any
 * other key as defence in depth.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const { sqlMock, adminMock } = vi.hoisted(() => ({ sqlMock: vi.fn(), adminMock: vi.fn() }));
// S-07d (migration 935): the connection INSERT runs on the migration_admin pool.
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: (_label: string, fn: (c: unknown) => unknown) =>
    fn({ query: async (t: string, p?: unknown[]) => ({ rows: await adminMock(t, p) }) }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_r: unknown, data: unknown) => ({ kind: 'success', data })),
    validationError: vi.fn((_r: unknown, e: unknown) => ({ kind: 'validation', e })),
    methodNotAllowed: vi.fn(() => ({ kind: '405' })),
  },
}));

import handler from '../../../pages/api/accounting/bank-feeds/index';
import { createBankFeedConnection } from '@/modules/accounting/services/bank/openBankingConnectionService';

const GL = '00000000-0000-4000-8000-000000000001';
const req = (body: unknown) => ({ method: 'POST', companyId: 'co', user: { id: 'u1' }, body }) as never;

beforeEach(() => { sqlMock.mockReset(); adminMock.mockReset(); });

describe('POST /bank-feeds config', () => {
  it('rejects credentials in config with a 400 and stores nothing', async () => {
    const out = await handler(req({
      provider: 'extension', accountId: GL, config: { username: 'me', password: 'hunter2' },
    }), {} as NextApiResponse) as { kind: string };
    expect(out.kind).toBe('validation');
    expect(sqlMock).not.toHaveBeenCalled();
    expect(adminMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown bankId and extra keys beside a valid one', async () => {
    for (const config of [{ bankId: 'fnb' }, { bankId: 'absa', pin: '1234' }]) {
      const out = await handler(req({ provider: 'extension', accountId: GL, config }), {} as NextApiResponse) as { kind: string };
      expect(out.kind).toBe('validation');
    }
    expect(sqlMock).not.toHaveBeenCalled();
    expect(adminMock).not.toHaveBeenCalled();
  });

  it('accepts { bankId: "absa" }', async () => {
    sqlMock.mockResolvedValueOnce([{ id: GL }]);
    adminMock.mockResolvedValueOnce([{
      id: 'conn', company_id: 'co', provider: 'extension', status: 'active', config: { bankId: 'absa' },
      created_at: 'x', updated_at: 'x',
    }]);
    const out = await handler(req({ provider: 'extension', accountId: GL, config: { bankId: 'absa' } }), {} as NextApiResponse) as { kind: string };
    expect(out.kind).toBe('success');
    expect(adminMock.mock.calls[0]![0]).toContain('INSERT INTO bank_feed_connections');
    expect(adminMock.mock.calls[0]![1]).toContain(JSON.stringify({ bankId: 'absa' }));
  });
});

describe('createBankFeedConnection config (defence in depth)', () => {
  it('refuses any config key other than bankId before writing', async () => {
    const config = { bankId: 'absa', password: 'hunter2' } as unknown as { bankId: string };
    await expect(createBankFeedConnection('co', { provider: 'extension', accountId: GL, config }, 'u1'))
      .rejects.toThrow(/config/i);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(adminMock).not.toHaveBeenCalled();
  });
});
