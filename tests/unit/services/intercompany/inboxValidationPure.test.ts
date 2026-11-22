/** inboxValidation is documented "Pure": importing it must not load the database module (the routes' 400s run before any SQL). */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => { throw new Error('neon imported'); });

describe('inboxValidation is pure', () => {
  it('loads without @/lib/neon and still checks a rejection reason', async () => {
    const { parseRejectBody, checkReason } = await import('@/modules/accounting/services/intercompany/inboxValidation');
    expect(parseRejectBody({ reason: '  Not ours ' })).toEqual({ ok: true, value: { reason: 'Not ours' } });
    expect(checkReason('')).toEqual({ ok: false, error: 'A reason is required to reject a message' });
    expect(checkReason('x'.repeat(2001))).toMatchObject({ ok: false });
  });

  it('handleService still exports the same checkReason (callers keep working)', async () => {
    vi.doUnmock('@/lib/neon');
    vi.resetModules();
    vi.doMock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn() }));
    const handle = await import('@/modules/accounting/services/intercompany/handleService');
    const pure = await import('@/modules/accounting/services/intercompany/inboxValidation');
    expect(handle.checkReason).toBe(pure.checkReason);
  });
});
