/**
 * Intercompany P4-D round 2 (M1): the Accept preview carries the invoice's date, and proposes the posting date from the LATER of the payment
 * date and the invoice date (a clearing is never dated before the invoice it settles).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ from: [] as string[] }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ loan_account_id: 'loan-1', account_code: '1400', account_name: 'Loan' }]) }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn(async () => ({ accountCode: '1200', accountName: 'AR' })) }));
vi.mock('@/modules/accounting/services/intercompany/allocationClearDate', () => ({
  todaySast: vi.fn(async () => '2026-11-23'),
  defaultPostingDate: vi.fn(async (_c: string, from: string) => { m.from.push(from); return from; }),
}));

import { clearingPreview } from '@/modules/accounting/services/intercompany/allocationClearPreview';

const payload = (date: string) => ({ amount: 400, payment: { date }, issuerDocument: { id: 'inv-1' } }) as never;
const invoice = (date: string | null) => ({ id: 'inv-1', number: 'INV-1', openAmount: 1150, status: 'approved', currency: 'ZAR', date });

beforeEach(() => { m.from = []; });

describe('clearingPreview', () => {
  it('the invoice dated after the payment: the invoice date is the floor', async () => {
    expect(await clearingPreview('co-1', 'c-1', payload('2026-09-01'), invoice('2026-09-05')))
      .toMatchObject({ paymentDate: '2026-09-01', invoiceDate: '2026-09-05', defaultPostingDate: '2026-09-05' });
    expect(m.from).toEqual(['2026-09-05']);
  });

  it('the invoice dated before the payment, or no invoice: the payment date', async () => {
    expect(await clearingPreview('co-1', 'c-1', payload('2026-09-01'), invoice('2026-08-01'))).toMatchObject({ invoiceDate: '2026-08-01', defaultPostingDate: '2026-09-01' });
    expect(await clearingPreview('co-1', 'c-1', payload('2026-09-01'), null)).toMatchObject({ invoiceDate: null, defaultPostingDate: '2026-09-01' });
  });
});
