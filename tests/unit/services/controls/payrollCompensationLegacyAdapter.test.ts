import {expect,it} from 'vitest';
import {assertCompensationCallerPlan} from '@/modules/accounting/services/controls/payrollCompensationLegacyAdapter';
const e='00000000-0000-4000-8000-000000000001',c='00000000-0000-4000-8000-000000000002',a='00000000-0000-4000-8000-000000000003';
const plan={version:1,source:{kind:'manual'},actions:[{kind:'assign',assignmentId:a,employeeId:e,componentId:c,amount:'100.00',effectiveFrom:'2026-10-01',effectiveTo:null,isRecurring:true}]};
it('compares complete normalized assertions and rejects changed compensation amounts',()=>{
 const input={version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:e,componentId:c,amount:'100',effectiveFrom:'2026-10-01'}]};
 expect(()=>assertCompensationCallerPlan(input,plan)).not.toThrow();
 expect(()=>assertCompensationCallerPlan({...input,actions:[{...input.actions[0],amount:'200'}]},plan)).toThrow(/assertion/i);
});
it('rejects caller accessors before invoking them',()=>{
 let calls=0;expect(()=>assertCompensationCallerPlan({get version(){calls++;return 1;}},plan)).toThrow();expect(calls).toBe(0);
});
