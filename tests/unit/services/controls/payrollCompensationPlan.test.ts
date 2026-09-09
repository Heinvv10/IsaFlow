import {expect,it} from 'vitest';
import {parsePayrollCompensationInput,parsePayrollCompensationPayload,compensationExposure} from '@/modules/accounting/services/controls/payrollCompensationPlan';
const employee='00000000-0000-4000-8000-000000000001',component='00000000-0000-4000-8000-000000000002',assignment='00000000-0000-4000-8000-000000000003';
const input=()=>({version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:employee,componentId:component,amount:'100.01',effectiveFrom:'2026-09-01',isRecurring:false}]});
it('normalizes once-off month end and exact cents without exposing caller references',()=>{
 const original=input(),parsed=parsePayrollCompensationInput(original);original.actions[0].amount='99.00';
 expect(parsed).toMatchObject({actions:[{amount:'100.01',effectiveTo:'2026-09-30'}]});
});
it('rejects accessor-bearing input before invoking it',()=>{let reads=0;const value={...input(),get actions(){reads++;return input().actions;}};
 expect(()=>parsePayrollCompensationInput(value)).toThrow(/property/i);expect(reads).toBe(0);
});
it('refuses negative, fractional-cent, overflowing or exponent amounts',()=>{
 for(const amount of ['-1','1.001','1000000000000','1e2']){const value=input();value.actions[0].amount=amount;expect(()=>parsePayrollCompensationInput(value)).toThrow();}
});
it('refuses impossible or inverted effective dates',()=>{
 expect(()=>parsePayrollCompensationInput({...input(),actions:[{...input().actions[0],effectiveFrom:'2026-02-30'}]})).toThrow();
 expect(()=>parsePayrollCompensationInput({...input(),actions:[{...input().actions[0],effectiveTo:'2026-08-31'}]})).toThrow();
});
it('rejects repeated end/amend actions targeting the same assignment',()=>{
 expect(()=>parsePayrollCompensationInput({version:1,source:{kind:'manual'},actions:[{kind:'amend',assignmentId:assignment,amount:'50.00'},{kind:'end',assignmentId:assignment,effectiveTo:'2026-09-30'}]})).toThrow(/duplicate/i);
});
it('accepts package/batch identity only and refuses caller material masquerading as persisted source',()=>{
 expect(parsePayrollCompensationInput({version:1,source:{kind:'package',sourceId:component,employeeId:employee},effectiveFrom:'2026-10-01'})).toMatchObject({source:{kind:'package'}});
 expect(()=>parsePayrollCompensationInput({version:1,source:{kind:'batch',sourceId:component},actions:input().actions})).toThrow();
});
it('binds complete immutable action rows and requires distinct server assignment IDs',()=>{
 const action={kind:'assign',assignmentId:assignment,employeeId:employee,componentId:component,amount:'100.00',effectiveFrom:'2026-09-01',effectiveTo:null,isRecurring:true};
 expect(parsePayrollCompensationPayload({version:1,source:{kind:'manual'},actions:[action]}).actions[0].assignmentId).toBe(assignment);
 expect(()=>parsePayrollCompensationPayload({version:1,source:{kind:'manual'},actions:[action,action]})).toThrow(/duplicate/i);
});
it('uses gross changed assignment exposure instead of netting salary replacements',()=>{
 expect(compensationExposure([{before:'100.00',after:'100.00'},{before:null,after:'200.00'}])).toBe('300.00');
 expect(compensationExposure([{before:'100.00',after:'50.00'}])).toBe('100.00');
});
