/**
 * sageKeyLock (B24-2, R25-5, R25-8, R27-3, R27-7, R28-4): the lock text the registry uses, and the query that names who holds it (its
 * application, ages, its role's / database's idle-transaction default); a lookup that fails is logged and said "could not be read"; a
 * holder that looks like a migration transaction left open is looked up a second time before ending it is offered. (The SQL itself runs
 * on a real cluster: sage-migration-runner-round25.int.test.ts.)
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
    expect(HOLDER_SQL).toMatch(/FROM pg_db_role_setting d/); // R28-2: the holder's own role / database default, never this session's
    expect(HOLDER_SQL).not.toMatch(/pg_settings/);
  });
  it('a held key: the holder query is asked with the same text, and its pid named', async () => {
    const asked: Array<[string, unknown[] | undefined]> = [];
    const client = { query: async (t: string, v?: unknown[]) => { asked.push([t, v]); return t.startsWith('SELECT pg_try') ? { rows: [{ ok: false }] } : { rows: [{ pid: 9, state: 'active', app: 'psql', ageS: 3, idleMs: 0 }] }; } };
    const err = await takeKeyLockNow(client, client, 'mcp:c:w:k', 'dry').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BatchKeyHeldError);
    expect((err as BatchKeyHeldError).holder).toMatchObject({ pid: 9, state: 'active', app: 'psql', ageS: 3, waiting: false, olderThanRun: false });
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
    expect((err as BatchKeyHeldError).holder).toMatchObject({ pid: 12, state: 'idle in transaction', app: null, ageS: null, idleMs: null });
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

describe('R28-4 / B28-3: a holder that looks like a migration transaction left open is looked up twice', () => {
  const ownIdle = (stateChangeMs: number) => ({ pid: 77, state: 'idle in transaction', app: 'isaflow-sage-migration', stateChangeMs, xactStartMs: 1_000 });
  const lookupOf = (rows: Array<Record<string, unknown>>) => ({ query: vi.fn(async () => ({ rows: [rows.length > 1 ? rows.shift()! : rows[0]!] })) });
  const held = { query: async () => ({ rows: [{ ok: false }] }) };
  it('still idle, state unchanged, older than the run lock: confirmed (offered for ending)', async () => {
    const lookup = lookupOf([ownIdle(500), ownIdle(500)]);
    const err = await takeKeyLockNow(held, lookup, 'k', 'dry', { runLockAt: 2_000, confirmMs: 0 }).then(() => null, (e: unknown) => e) as BatchKeyHeldError;
    expect(lookup.query).toHaveBeenCalledTimes(2);
    expect(err.holder).toMatchObject({ pid: 77, confirmedIdle: true, olderThanRun: true });
    expect(err.message).toContain('SELECT pg_terminate_backend(77) ends it');
  });
  it('its state moved between the samples (a live client between statements): not confirmed, left to its owner', async () => {
    const err = await takeKeyLockNow(held, lookupOf([ownIdle(500), ownIdle(900)]), 'k', 'dry', { runLockAt: 2_000, confirmMs: 0 }).then(() => null, (e: unknown) => e) as BatchKeyHeldError;
    expect(err.holder?.confirmedIdle).not.toBe(true);
    expect(err.message).toContain('check with whoever owns it before ending it');
    expect(err.message).not.toMatch(/pg_terminate_backend/);
  });
  it('a transaction from after this run took its lock is never "left open", and is looked up once only', async () => {
    const lookup = lookupOf([ownIdle(500)]);
    const err = await takeKeyLockNow(held, lookup, 'k', 'dry', { runLockAt: 500, confirmMs: 0 }).then(() => null, (e: unknown) => e) as BatchKeyHeldError;
    expect(lookup.query).toHaveBeenCalledTimes(1);
    expect(err.message).not.toMatch(/pg_terminate_backend/);
  });
});
