import {expect,it} from 'vitest';
import * as claims from '@/modules/accounting/services/ap/paymentReleaseClaim';
it('does not expose an acknowledgement primitive accepting caller-supplied transport outcomes',()=>{
 expect('completePaymentRelease' in claims).toBe(false);
});
