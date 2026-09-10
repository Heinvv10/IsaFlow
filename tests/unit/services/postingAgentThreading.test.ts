// Actual human/PAT parent journal and cookie REST provenance: arCiPosting.int.test.ts AR13–17.
import {expect,it} from 'vitest';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
it('caller posting metadata cannot substitute issued approval authority',async()=>{
 await expect(approveCustomerInvoice('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',{postingAgent:'mcp:caller:v1',actorType:'agent',actorTokenJti:'caller'})).rejects.toThrow('Authenticated');
});
