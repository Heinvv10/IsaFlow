import {expect,it} from 'vitest';
import {parseCashApplicationPlan,cashApplicationTotal} from '@/modules/accounting/services/shared/cashApplicationPlan';
const id='ABCDEFAB-1234-4123-8123-ABCDEFABCDEF';
const input={version:1,kind:'customer',paymentId:id,accountingDate:'2026-09-10',applications:[{invoiceId:id,amount:'9999999999999999999.99'}]};
it('freezes exact cents and canonical identifiers without Number conversion',()=>{
 const plan=parseCashApplicationPlan(input);expect(plan.paymentId).toBe(id.toLowerCase());expect(cashApplicationTotal(plan)).toBe('9999999999999999999.99');
});
it('rejects duplicate targets including UUID case variants and invalid dates',()=>{
 expect(()=>parseCashApplicationPlan({...input,applications:[...input.applications,{invoiceId:id.toLowerCase(),amount:'0.01'}]})).toThrow();
 expect(()=>parseCashApplicationPlan({...input,accountingDate:'2026-02-30'})).toThrow();
});
it('rejects fractional cents, numeric money, empty or oversized population and aggregate overflow',()=>{
 for(const amount of ['1.001','0','-1',1])expect(()=>parseCashApplicationPlan({...input,applications:[{invoiceId:id,amount}]})).toThrow();
 expect(()=>parseCashApplicationPlan({...input,applications:[]})).toThrow();
 expect(()=>parseCashApplicationPlan({...input,applications:Array.from({length:101},(_,n)=>({invoiceId:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,amount:'1'}))})).toThrow();
 expect(()=>cashApplicationTotal(parseCashApplicationPlan({...input,applications:[{invoiceId:id,amount:'99999999999999999999.99'},{invoiceId:'11111111-1111-4111-8111-111111111111',amount:'0.01'}]}))).toThrow();
});
it('rejects caller authored identity or source journal claims',()=>{
 expect(()=>parseCashApplicationPlan({...input,actorType:'human'})).toThrow();
 expect(()=>parseCashApplicationPlan({...input,journalEntryId:id})).toThrow();
});
