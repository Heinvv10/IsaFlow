import {expect,it} from 'vitest';
import {assertStandalonePaymentVoid} from '@/modules/accounting/services/ap/batchPaymentValidation';
it('refuses individual void of any batch child, including a one-payment batch',()=>{
 expect(()=>assertStandalonePaymentVoid('11111111-1111-4111-8111-111111111111')).toThrow('batch');
});
it('allows standalone payment reversal preflight',()=>{
 expect(()=>assertStandalonePaymentVoid(null)).not.toThrow();
 expect(()=>assertStandalonePaymentVoid(undefined)).not.toThrow();
});
