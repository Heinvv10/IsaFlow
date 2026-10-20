/**
 * Audit 2026-10-18 P3: the PAYE a SARS directive prescribes, one rule for the
 * pay run and the stand-alone directive payment (directivePaye).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { directivePaye } from '@/modules/accounting/services/payroll/payrollSeveranceDirective';

describe('directivePaye', () => {
  it('a rate is applied to the gross, rounded to the cent', () => {
    expect(directivePaye({ amount: '30000.00', tax_rate: '0.1800', tax_amount: null })).toBe(5400);
    expect(directivePaye({ amount: '12345.67', tax_rate: '0.1800', tax_amount: null })).toBe(2222.22);
  });

  it('a fixed amount is taken as it stands when there is no rate', () => {
    expect(directivePaye({ amount: '30000.00', tax_rate: null, tax_amount: '1234.56' })).toBe(1234.56);
  });

  it('the rate wins over a stored amount', () => {
    expect(directivePaye({ amount: '10000.00', tax_rate: '0.2000', tax_amount: '999.00' })).toBe(2000);
  });

  it('neither: null, so the directive is not payable', () => {
    expect(directivePaye({ amount: '10000.00', tax_rate: null, tax_amount: null })).toBeNull();
  });
});
