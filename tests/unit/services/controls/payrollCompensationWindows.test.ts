import {expect,it} from 'vitest';
import {assertCompensationWindow} from '@/modules/accounting/services/controls/payrollCompensationWindows';
const action={kind:'amend' as const,assignmentId:'a',employeeId:'e',componentId:'c',amount:'110.00',effectiveFrom:'2026-09-01',effectiveTo:null,isRecurring:true};
const before={...action,amount:'100.00'};
it('refuses an amount amendment affecting approved historical payroll',()=>{
 expect(()=>assertCompensationWindow(action,before,{lockdown_enabled:false},[{period_year:2026,period_month:9,status:'approved'}])).toThrow(/locked/i);
});
it('allows a future assignment without reinterpreting an earlier locked payroll',()=>{
 expect(()=>assertCompensationWindow({...action,kind:'assign',effectiveFrom:'2026-10-01'},null,{lockdown_enabled:false},[{period_year:2026,period_month:9,status:'paid'}])).not.toThrow();
});
it('checks only the removed days when an assignment is ended',()=>{
 expect(()=>assertCompensationWindow({...action,kind:'end',amount:'100.00',effectiveTo:'2026-09-30'},before,{lockdown_enabled:false},[{period_year:2026,period_month:9,status:'paid'}])).not.toThrow();
 expect(()=>assertCompensationWindow({...action,kind:'end',amount:'100.00',effectiveTo:'2026-09-15'},before,{lockdown_enabled:false},[{period_year:2026,period_month:9,status:'paid'}])).toThrow(/locked/i);
});
it('refuses changes backdated through company lockdown and assignment reopening',()=>{
 expect(()=>assertCompensationWindow(action,before,{lockdown_enabled:true,lockdown_date:'2026-09-30'},[])).toThrow(/lockdown/i);
 expect(()=>assertCompensationWindow({...action,kind:'end',effectiveTo:'2026-10-31'},{...before,effectiveTo:'2026-09-30'},{lockdown_enabled:false},[])).toThrow(/extend/i);
});
