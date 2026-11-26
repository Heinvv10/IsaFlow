/**
 * sageKeyLock (B24-2, R25-5, R25-8, R27-3, R27-7): the lock text the registry uses, and the query that names who holds it (with its
 * application, transaction age and the server's idle-transaction timeout); a lookup that fails is logged and said "could not be read".
 */
import { describe, expect, it, vi } from 'vitest';
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ log: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { HOLDER_SQL, idempotencyLockText, takeKeyLockNow } from '@/modules/accounting/services/sage-migration/sageKeyLock';
import { BatchKeyHeldError } from '@/modules/accounting/services/sage-migration/sageSessionErrors';

describe('the holder query (R25-5)', () => {
  it('reads a GRANTED xact advisory lock of the one-bigint form (objsubid 1) held by ANOTHER backend, by hashtext\'s two halves', () => {
    expect(HOLDER_SQL).toMatch(/l\.locktype = 'advisory' AND l\.granted AND l\.objsubid = 1 AND l\.pid <> pg_backend_pid\(\)/);
    expect(HOLDER_SQL).toMatch(/l\.classid = \(\(x\.k >> 32\) & 4294967295\)::oid AND l\.objid = \(x\.k & 4294967295\)::oid/);
    expect(HOLDER_SQL).toMatch(/SELECT hashtext\(\$1\)::bigint AS k/);
    expect(HOLDER_SQL).toMatch(/SELECT a\.pid, a\.state, a\.application_name AS app, EXTRACT\(EPOCH FROM now\(\) - a\.xact_start\)::int AS "ageS",/); // R26-4, R27-3
    expect(HOLDER_SQL).toMatch(/\(SELECT setting::int FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'\) AS "idleMs" FROM pg_locks l JOIN pg_stat_activity a ON a\.pid = l\.pid/);
  });
  it('a held key: the holder query is asked with the same text, and its pid named', async () => {
    const asked: Array<[string, unknown[] | undefined]> = [];
    const client = { query: async (t: string, v?: unknown[]) => { asked.push([t, v]); return t.startsWith('SELECT pg_try') ? { rows: [{ ok: false }] } : { rows: [{ pid: 9, state: 'active', app: 'psql', ageS: 3, idleMs: 0 }] }; } };
    const err = await takeKeyLockNow(client, client, 'mcp:c:w:k', 'dry').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BatchKeyHeldError);
    expect((err as BatchKeyHeldError).holder).toEqual({ pid: 9, state: 'active', app: 'psql', ageS: 3, idleMs: 0 });
    expect(asked).toEqual([['SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS ok', ['mcp:c:w:k']], [HOLDER_SQL, ['mcp:c:w:k']]]);
  });
});

describe('idempotencyLockText (R25-8)', () => {
  it('mcp:<company>:<tool>:<key trimmed>, and u:<user>: before it for a per-user tool', () => {
    expect(idempotencyLockText('c', 'w', ' k ')).toBe('mcp:c:w:k');
    expect(idempotencyLockText('c', 'w', 'k', 'u1')).toBe('mcp:c:w:u:u1:k');
  });
});

describe('the holder is read through the lookup (the pool), not the request\'s app_user connection', () => {
  it('asked there; a lookup that fails is logged and said "could not be read", the held key said all the same (R27-7)', async () => {
    const client = { query: async () => ({ rows: [{ ok: false }] }) };
    const lookup = { query: vi.fn(async () => ({ rows: [{ pid: 12, state: 'idle in transaction', app: null }] })) };
    const err = await takeKeyLockNow(client, lookup, 'mcp:c:w:k', 'dry').then(() => null, (e: unknown) => e);
    expect(lookup.query).toHaveBeenCalledWith(HOLDER_SQL, ['mcp:c:w:k']);
    expect((err as BatchKeyHeldError).holder).toEqual({ pid: 12, state: 'idle in transaction', app: null, ageS: null, idleMs: null });
    expect((err as BatchKeyHeldError).unread).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    const failing = { query: async () => { throw new Error('no connection'); } };
    const err2 = await takeKeyLockNow(client, failing, 'mcp:c:w:k', 'dry').then(() => null, (e: unknown) => e);
    expect(err2).toBeInstanceOf(BatchKeyHeldError);
    expect((err2 as BatchKeyHeldError).unread).toBe(true);
    expect((err2 as Error).message).toContain('who holds it could not be read (the lookup failed; see the log)');
    expect(warn).toHaveBeenCalledWith('sage migration: who holds the batch key could not be read', { message: 'no connection' }, 'sage-migration');
  });
});

