/**
 * withJitOff (boundedStatements.ts), the parts that are not Postgres: it does nothing outside a request transaction,
 * and inside one it puts the caller's jit back on every path. That the setting reaches the Banking list's statements
 * is proven against a real server in tests/integration/bank-list-jit-off.int.test.ts.
 */
import { afterEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn(() => ({})) }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withJitOff } from '@/modules/accounting/services/gl/dimensions/boundedStatements';
import { runInRequestCtx } from '../../../helpers/requestCtx';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const text = (c: unknown[]) => (c[0] as string[]).join('?');
const sets = () => mockSql.mock.calls.filter((c) => text(c).includes('set_config'));

/** The caller's jit is `prev`; the `failOn`-th set_config throws a pg error with `code`. */
function server(prev: string, failOn?: { n: number; code: string }) {
  let n = 0;
  mockSql.mockReset().mockImplementation(async (...args: unknown[]) => {
    const t = text(args);
    if (t.includes("current_setting('jit')")) return [{ jit: prev }];
    if (t.includes('set_config') && failOn && (n += 1) === failOn.n) throw Object.assign(new Error('restore failed'), { code: failOn.code });
    return [];
  });
}

afterEach(() => { vi.mocked(log.warn).mockClear(); vi.mocked(log.debug).mockClear(); });

describe('withJitOff', () => {
  it('outside a request transaction it sends nothing and just runs fn (a LOCAL setting would end with its own statement)', async () => {
    server('on');
    await expect(withJitOff(async () => 'ok')).resolves.toBe('ok');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('inside one it turns jit off transaction-locally, runs fn, and puts the caller\'s own value back', async () => {
    server('on');
    await expect(runInRequestCtx(() => withJitOff(async () => 'ok'))).resolves.toBe('ok');
    expect(sets().map(text)).toEqual(["SELECT set_config('jit', 'off', true)", "SELECT set_config('jit', ?, true)"]);
    expect(sets()[1]!.slice(1)).toEqual(['on']);
    expect(mockSql.mock.calls.some((c) => text(c).includes('statement_timeout'))).toBe(false);
  });

  it('restores after an error and re-throws that error untouched (no translation, unlike withBoundedStatements)', async () => {
    server('on');
    const boom = Object.assign(new Error('canceling statement'), { code: '57014' });
    await expect(runInRequestCtx(() => withJitOff(async () => { throw boom; }))).rejects.toBe(boom);
    expect(sets()).toHaveLength(2);
  });

  it('a restore that fails because the transaction is aborted (25P02) is debug noise and never replaces the original error', async () => {
    server('on', { n: 2, code: '25P02' });
    const boom = new Error('original');
    await expect(runInRequestCtx(() => withJitOff(async () => { throw boom; }))).rejects.toBe(boom);
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('any other restore failure after an error is a warning; after success it is thrown', async () => {
    server('on', { n: 2, code: '08006' });
    const boom = new Error('original');
    await expect(runInRequestCtx(() => withJitOff(async () => { throw boom; }))).rejects.toBe(boom);
    expect(log.warn).toHaveBeenCalledTimes(1);
    server('on', { n: 2, code: '08006' });
    await expect(runInRequestCtx(() => withJitOff(async () => 'ok'))).rejects.toMatchObject({ code: '08006' });
  });
});
