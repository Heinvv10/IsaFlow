/**
 * Only a clash on the NUMBERING index renumbers.
 *
 * `insertWithReservedNumber`'s attempt closure now writes line items as well as
 * the header, so a 23505 raised by any other unique constraint the document
 * touches used to be read as "that number is taken": it burned four more
 * sequence numbers, retried an insert that would never succeed, and then
 * surfaced an error naming the wrong cause. Blind review r3, LOW-1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({
  withSavepoint: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

vi.mock('@/modules/accounting/services/core/companySettingsService', () => ({
  reserveNextDocumentNumber: vi.fn(),
}));

import { insertWithReservedNumber } from '@/modules/accounting/services/core/documentNumberRetry';
import { reserveNextDocumentNumber } from '@/modules/accounting/services/core/companySettingsService';

const reserve = reserveNextDocumentNumber as unknown as ReturnType<typeof vi.fn>;
const COMPANY = '11111111-1111-1111-1111-111111111111';
const NUMBER_INDEX = 'uq_customer_invoices_company_number';

function dup(constraint: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505', constraint,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  let n = 1;
  reserve.mockImplementation(() => Promise.resolve(`INV${String(n++).padStart(7, '0')}`));
});

describe('insertWithReservedNumber', () => {
  it('renumbers past a legacy row holding the number', async () => {
    const seen: string[] = [];
    const out = await insertWithReservedNumber(COMPANY, 'customer_invoice', 'sp_', NUMBER_INDEX,
      async (number) => {
        seen.push(number);
        if (seen.length === 1) throw dup(NUMBER_INDEX);
        return 'inv-1';
      });

    expect(out).toBe('inv-1');
    expect(seen).toEqual(['INV0000001', 'INV0000002']);
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it('rethrows a 23505 from a DIFFERENT constraint without burning a number', async () => {
    const other = dup('uq_customer_invoice_items_line');
    let attempts = 0;

    await expect(insertWithReservedNumber(COMPANY, 'customer_invoice', 'sp_', NUMBER_INDEX,
      async () => { attempts += 1; throw other; })).rejects.toBe(other);

    // One attempt, one reservation: the caller sees the real cause, and the
    // sequence has not advanced four times for a clash it cannot resolve.
    expect(attempts).toBe(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-23505 error untouched', async () => {
    const boom = Object.assign(new Error('not null violation'), { code: '23502' });
    await expect(insertWithReservedNumber(COMPANY, 'customer_invoice', 'sp_', NUMBER_INDEX,
      async () => { throw boom; })).rejects.toBe(boom);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('gives up after five clashes on the numbering index', async () => {
    const clash = dup(NUMBER_INDEX);
    let attempts = 0;
    await expect(insertWithReservedNumber(COMPANY, 'customer_invoice', 'sp_', NUMBER_INDEX,
      async () => { attempts += 1; throw clash; })).rejects.toBe(clash);
    expect(attempts).toBe(5);
  });
});
