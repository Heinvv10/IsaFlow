import {expect,it} from 'vitest';
import {expandPayrollCompensation} from '@/modules/accounting/services/controls/payrollCompensationExpand';
import type {CompensationSources} from '@/modules/accounting/services/controls/payrollCompensationSource';
const e='00000000-0000-4000-8000-000000000001',c='00000000-0000-4000-8000-000000000002',a='00000000-0000-4000-8000-000000000003';
const sources=():CompensationSources=>({company:{lockdown_enabled:false},employees:[{id:e,status:'active',start_date:'2020-01-01',end_date:null}],components:[{id:c,is_active:true}],assignments:[{id:a,employee_id:e,component_id:c,amount:'100.00',effective_from:'2026-09-01',effective_to:null,is_recurring:true}],runs:[],versions:[],sourceHeader:null,sourceLines:[]});
it('expands reductions with original exposure and refuses no-op changes',()=>{
 const result=expandPayrollCompensation({version:1,source:{kind:'manual'},actions:[{kind:'amend',assignmentId:a,amount:'50'}]},sources());
 expect(result.amount).toBe('100.00');expect(result.effectiveDate).toBe('2026-09-01');
 expect(()=>expandPayrollCompensation({version:1,source:{kind:'manual'},actions:[{kind:'amend',assignmentId:a,amount:'100'}]},sources())).toThrow(/unchanged/i);
});
it('refuses foreign components, terminated employees and locked historical edits',()=>{
 const input={version:1,source:{kind:'manual'},actions:[{kind:'amend',assignmentId:a,amount:'50'}]};
 const foreign=sources();foreign.components=[];expect(()=>expandPayrollCompensation(input,foreign)).toThrow(/component/i);
 const terminated=sources();terminated.employees[0]!.status='terminated';expect(()=>expandPayrollCompensation(input,terminated)).toThrow(/employee/i);
 const locked=sources();locked.runs=[{period_year:2026,period_month:9,status:'approved'}];expect(()=>expandPayrollCompensation(input,locked)).toThrow(/locked/i);
});
it('expands a package replacement as retained closure plus new full assignment',()=>{
 const s=sources();s.sourceHeader={is_active:true};s.sourceLines=[{component_id:c,amount:'200.00',is_recurring:true}];
 const result=expandPayrollCompensation({version:1,source:{kind:'package',sourceId:a,employeeId:e},effectiveFrom:'2026-10-01'},s);
 expect(result.amount).toBe('300.00');expect(result.payload.actions).toHaveLength(2);
 expect(result.payload.actions.find(x=>x.kind==='end')?.effectiveTo).toBe('2026-09-30');
});
it('refuses unvalidated batches and mismatched travel portions',()=>{
 const s=sources();s.sourceHeader={status:'draft'};
 expect(()=>expandPayrollCompensation({version:1,source:{kind:'batch',sourceId:a}},s)).toThrow(/validated/i);
 s.sourceHeader={status:'validated',batch_type:'reimbursive_travel',is_recurring:false,line_count:1,total_amount:'50.00'};s.sourceLines=[{employee_id:e,km:'10',rate_per_km:'5',value:'50',taxable_portion:'40',non_taxable_portion:'40',effective_from:'2026-10-01',effective_to:null}];
 expect(()=>expandPayrollCompensation({version:1,source:{kind:'batch',sourceId:a}},s)).toThrow(/portion/i);
});
it('refuses incomplete batch source populations before deriving approved changes',()=>{
 const s=sources();s.sourceHeader={status:'validated',batch_type:'component_values',component_id:c,is_recurring:true,line_count:2,total_amount:'50.00'};
 s.sourceLines=[{employee_id:e,value:'50.00',effective_from:'2026-10-01',effective_to:null}];
 expect(()=>expandPayrollCompensation({version:1,source:{kind:'batch',sourceId:a}},s)).toThrow(/population/i);
});
