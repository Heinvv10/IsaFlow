import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  // Pass-through: the per-attempt savepoint's rollback is proved against a real
  // Postgres in tests/integration/k-040-wip-overlapping-runs-double-bill.int.test.ts.
  withSavepoint: <T>(_name: string, fn: () => Promise<T>) => fn(),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { insertWipInvoice } from '@/modules/accounting/services/practice/wipInvoiceNumber';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const INVOICE_ID = '11111111-0000-0000-0000-000000000007';

const header = {
  customerId: 'dddddddd-0000-0000-0000-000000000004',
  userId: 'bbbbbbbb-0000-0000-0000-000000000002',
  subtotal: 4250,
  taxRate: 15,
  taxAmount: 637.5,
  totalAmount: 4887.5,
  invoiceDate: '2026-04-12',
};

const uniqueViolation = () =>
  Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

beforeEach(() => vi.clearAllMocks());

describe('insertWipInvoice', () => {
  it('takes MAX + 1 when no peer has taken the number', async () => {
    sqlMock.mockResolvedValueOnce([{ max_num: 4 }]);
    sqlMock.mockResolvedValueOnce([{ id: INVOICE_ID }]);

    await expect(insertWipInvoice(COMPANY, header))
      .resolves.toEqual({ invoiceId: INVOICE_ID, invoiceNumber: 'INV-00005' });
  });

  it('takes the number immediately after the peer\'s, leaving no gap in the sequence', async () => {
    sqlMock.mockResolvedValueOnce([{ max_num: 1 }]);   // attempt 0 reads MAX = 1
    sqlMock.mockRejectedValueOnce(uniqueViolation());  // peer committed INV-00002 first
    sqlMock.mockResolvedValueOnce([{ max_num: 2 }]);   // re-read now sees the peer's number
    sqlMock.mockResolvedValueOnce([{ id: INVOICE_ID }]);

    const result = await insertWipInvoice(COMPANY, header);

    // INV-00003, not INV-00004: the re-read MAX already accounts for the peer,
    // so offsetting by the attempt count would burn INV-00003 and gap the sequence.
    expect(result.invoiceNumber).toBe('INV-00003');
    expect(result.invoiceId).toBe(INVOICE_ID);
  });

  it('stays contiguous across two consecutive collisions', async () => {
    sqlMock.mockResolvedValueOnce([{ max_num: 0 }]);
    sqlMock.mockRejectedValueOnce(uniqueViolation());
    sqlMock.mockResolvedValueOnce([{ max_num: 1 }]);
    sqlMock.mockRejectedValueOnce(uniqueViolation());
    sqlMock.mockResolvedValueOnce([{ max_num: 2 }]);
    sqlMock.mockResolvedValueOnce([{ id: INVOICE_ID }]);

    await expect(insertWipInvoice(COMPANY, header))
      .resolves.toMatchObject({ invoiceNumber: 'INV-00003' });
  });

  it('gives up after five attempts, surfacing the last collision', async () => {
    for (let i = 0; i < 5; i++) {
      sqlMock.mockResolvedValueOnce([{ max_num: i }]);
      sqlMock.mockRejectedValueOnce(uniqueViolation());
    }
    // The fifth attempt rethrows its own 23505 rather than a summary message.
    await expect(insertWipInvoice(COMPANY, header)).rejects.toThrow(/unique constraint/);
    expect(sqlMock).toHaveBeenCalledTimes(10);
  });

  it('does not retry an error that is not a unique violation', async () => {
    sqlMock.mockResolvedValueOnce([{ max_num: 0 }]);
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }));

    await expect(insertWipInvoice(COMPANY, header)).rejects.toThrow(/deadlock detected/);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });
});
