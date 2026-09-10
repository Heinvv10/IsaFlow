// Actual cancelled/unlinked invoice and unchanged journal/effect proof: arCiPosting.int.test.ts AR12.
import {expect,it} from 'vitest';
import {postCustomerInvoiceToGL} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
it('an unissued caller cannot attempt invoice posting',async()=>{
 await expect(postCustomerInvoiceToGL('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333')).rejects.toThrow('Authenticated');
});
