import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
import { attachReceiverNames } from '@/modules/accounting/services/ap/grnReceiverNames';

const U1 = '3f2b8c1e-9d4a-4e7b-8a61-0c5d2e7f9a10';
const U2 = '7a1d4c22-1b0e-4f55-9c3d-2e8a6b1f0d33';
beforeEach(() => sqlMock.mockReset());

describe('attachReceiverNames', () => {
  it('resolves each distinct creator once and keeps typed text as typed', async () => {
    sqlMock.mockResolvedValueOnce([{ id: U1, name: 'Sam Receiver' }, { id: U2, name: 'Pat Clerk' }]);
    const out = await attachReceiverNames('c1', [
      { received_by: U1, created_by: U1 }, { received_by: U1, created_by: U1 }, { received_by: U2, created_by: U2 },
      { received_by: 'Gate guard', created_by: U1 },
    ]);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual(['c1', [U1, U2]]);
    expect(out.map((r) => r.received_by_name)).toEqual(['Sam Receiver', 'Sam Receiver', 'Pat Clerk', 'Gate guard']);
  });
  it('shows "Unknown user", never the raw id, when the creator no longer resolves', async () => {
    sqlMock.mockResolvedValueOnce([{ id: U1, name: null }]);
    const [row] = await attachReceiverNames('c1', [{ received_by: U1, created_by: U1 }]);
    expect(row!.received_by_name).toBe('Unknown user');
  });
  it('makes no lookup when every note has typed text', async () => {
    const out = await attachReceiverNames('c1', [{ received_by: 'Gate guard', created_by: U1 }]);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(out[0]!.received_by_name).toBe('Gate guard');
  });
});
