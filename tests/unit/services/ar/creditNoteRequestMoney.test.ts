/**
 * The money a credit-note create may carry (#1701 round 8 item 8): the rate is stored as NUMERIC(5,2), so a rate with a
 * third decimal is refused on both surfaces in the same words (15.005 would be stored 15.01 and imply R1,501.00 on a
 * R10,000 note carrying R1,500.50). Agreement of a figure and a rate is judged at the rate as stored.
 */
import { describe, expect, it } from 'vitest';
import { MCP_MONEY_FIELDS, REST_MONEY_FIELDS, creditNoteMoneyProblem } from '@/modules/accounting/services/ar/creditNoteRequestMoney';

describe('creditNoteMoneyProblem: the rate at its stored precision', () => {
  it('the gate\'s example: 10,000 at 15.005 with VAT 1,500.50 is refused on REST and MCP, each naming its field', () => {
    expect(creditNoteMoneyProblem({ subtotal: 10000, taxRate: 15.005, taxAmount: 1500.5 }, REST_MONEY_FIELDS))
      .toBe('taxRate must have at most two decimal places (it is stored to the hundredth)');
    expect(creditNoteMoneyProblem({ subtotal: 10000, taxRate: 15.005, taxAmount: 1500.5 }, MCP_MONEY_FIELDS))
      .toBe('tax_rate must have at most two decimal places (it is stored to the hundredth)');
  });
  it('a rate alone with three decimals is refused too; two decimals pass', () => {
    expect(creditNoteMoneyProblem({ subtotal: 100, taxRate: 14.999, taxAmount: undefined })).toMatch(/at most two decimal places/);
    expect(creditNoteMoneyProblem({ subtotal: 100, taxRate: 15.01, taxAmount: undefined })).toBeNull();
    expect(creditNoteMoneyProblem({ subtotal: 10000, taxRate: 15.01, taxAmount: 1501 })).toBeNull();
  });
  it('a figure that the stored rate does not give is still refused', () => {
    expect(creditNoteMoneyProblem({ subtotal: 10000, taxRate: 15.01, taxAmount: 1500.5 })).toMatch(/^taxRate 15\.01 does not give taxAmount 1500\.50/);
  });
  it('the range and the other checks are unchanged', () => {
    expect(creditNoteMoneyProblem({ subtotal: 100, taxRate: 100.5, taxAmount: undefined })).toBe('taxRate must be a number from 0 to 100');
    expect(creditNoteMoneyProblem({ subtotal: 100, taxRate: '15', taxAmount: undefined })).toBe('taxRate must be a number from 0 to 100');
    expect(creditNoteMoneyProblem({ subtotal: 100, taxRate: 15, taxAmount: 15 })).toBeNull();
  });
});
