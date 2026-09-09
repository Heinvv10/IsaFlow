import {expect,it} from 'vitest';
import {parseCashApplicationReversalPlan} from '@/modules/accounting/services/shared/cashApplicationPlan';
const input={originalIntentId:'ABCDEFAB-1234-4123-8123-ABCDEFABCDEF',reversalDate:'2026-10-01',reason:' Correction '};
it('freezes the original intent and explicit real reversal date/reason',()=>{
 expect(parseCashApplicationReversalPlan(input)).toEqual({...input,originalIntentId:input.originalIntentId.toLowerCase(),reason:'Correction'});
});
it('refuses invalid dates, missing reason and caller-authored allocation replacements',()=>{
 expect(()=>parseCashApplicationReversalPlan({...input,reversalDate:'2026-02-30'})).toThrow();
 expect(()=>parseCashApplicationReversalPlan({...input,reason:' '})).toThrow();
 expect(()=>parseCashApplicationReversalPlan({...input,applications:[]})).toThrow();
});
