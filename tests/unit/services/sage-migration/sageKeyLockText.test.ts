/**
 * B24-2: the migration session takes a write tool's idempotency lock itself, without waiting (sageToolSession.ts takeKeyLockNow), so it
 * must lock the SAME text the registry locks (src/lib/mcp/audit.ts acquireIdempotencyLock). sageToolSessionCall pins the session's text
 * ('mcp:c1:w:batch-1'); this pins the registry's, so a change on either side fails one of them.
 */
import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ values: [] as unknown[][] }));
vi.mock('@/lib/neon', () => ({ sql: (_strings: TemplateStringsArray, ...values: unknown[]) => { seen.values.push(values); return Promise.resolve([]); } }));

import { acquireIdempotencyLock } from '@/lib/mcp/audit';

describe('the idempotency lock text', () => {
  it('is mcp:<company>:<tool>:<key>, as the migration session takes it', async () => {
    await acquireIdempotencyLock('c1', 'w', 'batch-1');
    expect(seen.values).toEqual([['mcp:c1:w:batch-1']]);
  });
});
