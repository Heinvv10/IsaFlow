/**
 * The entity-type change check locks the company row first; seeing no row (deleted, or hidden
 * from this user by RLS) is an error, never "no issues" (which would let the change through).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(() => Promise.resolve([])) }));
import { entityTypeChangeIssues } from '@/modules/onboarding/services/entityTypeChange';

describe('entityTypeChangeIssues', () => {
  it('throws when the company row is not there to lock', async () => {
    await expect(entityTypeChangeIssues('00000000-0000-4000-8000-000000000001', 'cc')).rejects.toThrow(/no company row/);
  });
});
