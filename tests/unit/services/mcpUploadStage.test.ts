/**
 * stageUploadBytes on the upload admin pool: a held row / statement timeout / busy pool is
 * UploadStageLockTimeoutError (503 upstream); a connection whose ROLLBACK failed is destroyed, never reused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: logs }));
const client = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
const pool = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('@/lib/mcp/uploadAdminPool', () => ({ uploadAdminPool: () => pool }));

import { stageUploadBytes, UploadStageLockTimeoutError } from '@/modules/accounting/services/core/mcpUploadIntentStore';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const B = Buffer.from('x');

beforeEach(() => {
  vi.clearAllMocks();
  pool.connect.mockResolvedValue(client);
  client.query.mockResolvedValue({ rowCount: 1 });
});

describe('stageUploadBytes', () => {
  it('stages in a bounded transaction and returns the connection to the pool', async () => {
    expect(await stageUploadBytes('co', 'id', B)).toBe(true);
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls).toContain("SET LOCAL lock_timeout = '2s'");
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('a held row (55P03) is UploadStageLockTimeoutError, rolled back, connection reused', async () => {
    client.query.mockImplementation(async (q: string) => {
      if (q.startsWith('UPDATE')) throw pgError('55P03');
      return { rowCount: 0 };
    });
    await expect(stageUploadBytes('co', 'id', B)).rejects.toBeInstanceOf(UploadStageLockTimeoutError);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('a statement timeout (57014) is a retry too, and logged apart from contention', async () => {
    client.query.mockImplementation(async (q: string) => {
      if (q.startsWith('UPDATE')) throw pgError('57014');
      return { rowCount: 0 };
    });
    await expect(stageUploadBytes('co', 'id', B)).rejects.toBeInstanceOf(UploadStageLockTimeoutError);
    expect(logs.warn).toHaveBeenCalledWith('MCP upload stage ran past its statement timeout', expect.anything(), 'mcp-uploads');
  });

  it('destroys a connection whose ROLLBACK failed instead of handing it to the next PUT', async () => {
    client.query.mockImplementation(async (q: string) => {
      if (q.startsWith('UPDATE')) throw pgError('XX000');
      if (q === 'ROLLBACK') throw new Error('connection terminated');
      return { rowCount: 0 };
    });
    await expect(stageUploadBytes('co', 'id', B)).rejects.toThrow('pg XX000');
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('no pool connection within the connect timeout is UploadStageLockTimeoutError', async () => {
    pool.connect.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    await expect(stageUploadBytes('co', 'id', B)).rejects.toBeInstanceOf(UploadStageLockTimeoutError);
  });
});
