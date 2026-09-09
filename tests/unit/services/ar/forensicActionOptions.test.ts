import {expect,it} from 'vitest';
import {parseArActionOptions} from '@/modules/accounting/services/ar/arActionOptions';
it('forwards only validated references and a real calendar reversal date',()=>{
 const approvalId='00000000-0000-4000-8000-000000000001';
 expect(parseArActionOptions({approvalId,reversalDate:'2026-09-10',actorId:'forged'})).toEqual({approvalId,reversalDate:'2026-09-10'});
});
it('refuses malformed reference and impossible reversal date at API ingress',()=>{
 expect(()=>parseArActionOptions({approvalId:'forged'})).toThrow();
 expect(()=>parseArActionOptions({reversalDate:'2026-02-30'})).toThrow();
});
