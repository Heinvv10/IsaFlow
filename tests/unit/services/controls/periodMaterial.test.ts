import { expect, it } from 'vitest';
import { parseVatPeriodId } from '@/modules/accounting/services/controls/periodOperationMaterializer';
it('accepts an exact owned VAT date-pair reference shape', () => {
  expect(parseVatPeriodId('2026-01-01/2026-02-28')).toEqual({ start: '2026-01-01', end: '2026-02-28' });
});
it.each(['2026-02-30/2026-03-31', '2026-03-01/2026-02-28', '2026-01-01/2026-02-28/extra', '2026-01-01'])('rejects ambiguous or impossible VAT reference %s', id => {
  expect(() => parseVatPeriodId(id)).toThrow('Invalid VAT period reference');
});
