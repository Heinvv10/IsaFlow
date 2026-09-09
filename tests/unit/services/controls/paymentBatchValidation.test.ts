import {expect,it} from 'vitest';
import {validateBatchInput} from '@/modules/accounting/services/ap/batchPaymentValidation';
const supplier='11111111-1111-4111-8111-111111111111',invoice='22222222-2222-4222-8222-222222222222';
it('checks exact bounded allocations before creating any batch',()=>{
 const input={batchDate:'2026-09-09',payments:[{supplierId:supplier,invoiceAllocations:[{invoiceId:invoice,amount:12.34}]}]};
 expect(validateBatchInput(input).total).toBe('12.34');
 expect(()=>validateBatchInput({...input,payments:[]})).toThrow();
 expect(()=>validateBatchInput({...input,payments:[...input.payments,...input.payments]})).toThrow('Duplicate');
 expect(()=>validateBatchInput({...input,batchDate:'2026-02-30'})).toThrow('date');
 expect(()=>validateBatchInput({...input,payments:[{supplierId:supplier,invoiceAllocations:[{invoiceId:invoice,amount:0.001}]}]})).toThrow();
});
