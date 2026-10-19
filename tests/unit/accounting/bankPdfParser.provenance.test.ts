/**
 * Which parser produced a PDF's rows. The background import trusts rows only from the parser written
 * for the statement's own bank ('native'); the router's last resort, the ABSA date-amount pattern
 * applied to another bank's layout ('fallback'), reads some rows and drops the rest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syntheticPdf } from '../helpers/syntheticPdf';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const factory = vi.hoisted(() => ({ parseBankStatementText: vi.fn() }));
vi.mock('@/modules/accounting/utils/bankPdfParserFactory', () => factory);

import { parseBankPdf } from '@/modules/accounting/utils/bankPdfParser';

const ABSA_ROW = '05/03/2026 SHOP PAYMENT 100.00 900.00';
const absaPdf = () => syntheticPdf([['Absa Bank Limited', 'Balance Brought Forward 1000.00', ABSA_ROW]]);
const nedbankPdf = () => syntheticPdf([['Nedbank Limited', ABSA_ROW]]);
const unknownPdf = () => syntheticPdf([['Some other bank', ABSA_ROW]]);

beforeEach(() => {
  factory.parseBankStatementText.mockReset();
  factory.parseBankStatementText.mockReturnValue({ transactions: [], errors: [], bankFormat: 'nedbank' });
});

describe('parseBankPdf — which parser read the rows', () => {
  it('ABSA\'s own parser for an ABSA statement is native', async () => {
    const r = await parseBankPdf(absaPdf());
    expect(r.transactions).toHaveLength(1);
    expect(r.bankFormat).toBe('absa');
    expect(r.parser).toBe('native');
  });

  it('the factory parser for a recognised bank is native', async () => {
    factory.parseBankStatementText.mockReturnValue({
      transactions: [{ transactionDate: '2026-03-05', amount: -100, description: 'Shop' }],
      errors: [], bankFormat: 'nedbank',
    });
    const r = await parseBankPdf(nedbankPdf());
    expect(r.parser).toBe('native');
    expect(r.bankFormat).toBe('nedbank');
  });

  it('the ABSA pattern applied to a recognised bank whose own parser found nothing is a fallback', async () => {
    const r = await parseBankPdf(nedbankPdf());
    expect(r.transactions).toHaveLength(1);
    expect(r.bankFormat).toBe('nedbank');
    expect(r.parser).toBe('fallback');
  });

  it('the ABSA pattern applied to an unrecognised layout is a fallback', async () => {
    const r = await parseBankPdf(unknownPdf());
    expect(r.transactions).toHaveLength(1);
    expect(r.parser).toBe('fallback');
  });
});
