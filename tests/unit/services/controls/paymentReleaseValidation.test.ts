import {expect,it} from 'vitest';
import {paymentReleaseAmount,validateReleasePopulation} from '@/modules/accounting/services/ap/paymentReleaseValidation';
it('converts exact positive ZAR values to safe integer cents and rejects lossy amounts',()=>{
 expect(paymentReleaseAmount('123.45','ZAR')).toEqual({amount:'123.45',cents:12345});
 for(const value of ['0','-1','1.001','NaN','Infinity','90071992547409.92'])expect(()=>paymentReleaseAmount(value,'ZAR')).toThrow();
 expect(()=>paymentReleaseAmount('1','USD')).toThrow('currency');
});
it('rejects duplicate, empty, oversized and mismatched persisted payment populations',()=>{
 const row={id:'11111111-1111-4111-8111-111111111111',supplierId:'22222222-2222-4222-8222-222222222222',amount:'10',currency:'ZAR'};
 expect(validateReleasePopulation([row],'10',1)).toEqual({amount:'10',currency:'ZAR',cents:1000});
 expect(()=>validateReleasePopulation([],'0',0)).toThrow();
 expect(()=>validateReleasePopulation([row,row],'20',2)).toThrow('Duplicate');
 expect(()=>validateReleasePopulation([row],'11',1)).toThrow('reconcile');
 expect(()=>validateReleasePopulation([row],'10',2)).toThrow('count');
});
it('requires consumed release approval to remain unexpired at dispatch',async()=>{
 const {assertReleaseApprovalCurrent}=await import('@/modules/accounting/services/ap/paymentReleaseValidation');
 expect(()=>assertReleaseApprovalCurrent({status:'consumed',unexpired:false})).toThrow('expired');
 expect(()=>assertReleaseApprovalCurrent({status:'approved',unexpired:true})).toThrow();
 expect(()=>assertReleaseApprovalCurrent({status:'consumed',unexpired:true})).not.toThrow();
});
