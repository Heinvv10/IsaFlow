/** sageKeyLock (B24-2, R25-5, R25-8): the lock text the registry uses, and the query that names who holds it. */
import { describe, expect, it } from 'vitest';
import { HOLDER_SQL, idempotencyLockText, takeKeyLockNow } from '@/modules/accounting/services/sage-migration/sageKeyLock';
import { BatchKeyHeldError } from '@/modules/accounting/services/sage-migration/sageSessionErrors';

describe('the holder query (R25-5)', () => {
  it('reads a GRANTED xact advisory lock of the one-bigint form (objsubid 1) held by ANOTHER backend, by hashtext\'s two halves', () => {
    expect(HOLDER_SQL).toMatch(/l\.locktype = 'advisory' AND l\.granted AND l\.objsubid = 1 AND l\.pid <> pg_backend_pid\(\)/);
    expect(HOLDER_SQL).toMatch(/l\.classid = \(\(x\.k >> 32\) & 4294967295\)::oid AND l\.objid = \(x\.k & 4294967295\)::oid/);
    expect(HOLDER_SQL).toMatch(/SELECT hashtext\(\$1\)::bigint AS k/);
  });
  it('a held key: the holder query is asked with the same text, and its pid named', async () => {
    const asked: Array<[string, unknown[] | undefined]> = [];
    const client = { query: async (t: string, v?: unknown[]) => { asked.push([t, v]); return t.startsWith('SELECT pg_try') ? { rows: [{ ok: false }] } : { rows: [{ pid: 9 }] }; } };
    const err = await takeKeyLockNow(client, 'mcp:c:w:k', 'dry').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BatchKeyHeldError);
    expect((err as BatchKeyHeldError).holder).toBe(9);
    expect(asked).toEqual([['SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS ok', ['mcp:c:w:k']], [HOLDER_SQL, ['mcp:c:w:k']]]);
  });
});

describe('idempotencyLockText (R25-8)', () => {
  it('mcp:<company>:<tool>:<key trimmed>, and u:<user>: before it for a per-user tool', () => {
    expect(idempotencyLockText('c', 'w', ' k ')).toBe('mcp:c:w:k');
    expect(idempotencyLockText('c', 'w', 'k', 'u1')).toBe('mcp:c:w:u:u1:k');
  });
});
