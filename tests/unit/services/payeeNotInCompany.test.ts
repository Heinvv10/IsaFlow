import { describe, it, expect } from 'vitest';
import { payeesNotInCompany } from '@/modules/accounting/services/ap/payeeNotInCompany';

describe('payeesNotInCompany', () => {
  it('names the payment number when there is one', () => {
    const [msg] = payeesNotInCompany([{ payee_id: 'x' }, { payee_id: null, payment_number: 'SP-1' }]);
    expect(msg).toMatch(/^Payment 2 \(SP-1\): names a supplier/);
  });

  it.each([[null], [undefined], ['']])('omits the parenthetical when payment_number is %s', (num) => {
    const [msg] = payeesNotInCompany([{ payee_id: null, payment_number: num }]);
    expect(msg).toMatch(/^Payment 1: names a supplier/);
    expect(msg).not.toContain('null');
    expect(msg).not.toContain('undefined');
  });

  it('is silent when every payee is in the company', () => {
    expect(payeesNotInCompany([{ payee_id: 'a' }])).toEqual([]);
  });
});
