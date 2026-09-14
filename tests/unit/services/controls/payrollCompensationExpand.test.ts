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
// Ported from payPackageService.test.ts, which pinned both of these against the pre-controls
// applyPackageToEmployee. That function is a delegating shim now, so the rules live here.
it('closes a once-off package row at its own month end and leaves a recurring one open',()=>{
 const d='00000000-0000-4000-8000-000000000004';
 const s=sources();s.components.push({id:d,is_active:true});s.sourceHeader={is_active:true};
 s.sourceLines=[{component_id:c,amount:'200.00',is_recurring:true},{component_id:d,amount:'50.00',is_recurring:false}];
 const result=expandPayrollCompensation({version:1,source:{kind:'package',sourceId:a,employeeId:e},effectiveFrom:'2026-10-15'},s);
 const assigns=result.payload.actions.filter(x=>x.kind==='assign');
 expect(assigns.find(x=>x.componentId===c)!.effectiveTo).toBeNull();
 // The run reads the date window and ignores is_recurring, so an open-ended once-off row is paid
 // every later month. It dies at the end of its OWN month, not the run's.
 expect(assigns.find(x=>x.componentId===d)!.effectiveTo).toBe('2026-10-31');
});
it('supersedes an already-closed overlapping assignment, not only the open-ended ones',()=>{
 const s=sources();s.assignments[0]!.effective_to='2026-10-31';s.assignments[0]!.is_recurring=false;
 s.sourceHeader={is_active:true};s.sourceLines=[{component_id:c,amount:'200.00',is_recurring:false}];
 const result=expandPayrollCompensation({version:1,source:{kind:'package',sourceId:a,employeeId:e},effectiveFrom:'2026-10-01'},s);
 // An effective_to IS NULL predicate steps over the previous apply's closed row and leaves two
 // live windows the run pays twice.
 expect(result.payload.actions.find(x=>x.kind==='end')?.effectiveTo).toBe('2026-09-30');
});
it('refuses unvalidated batches and mismatched travel portions',()=>{
 const s=sources();s.sourceHeader={status:'draft'};
 expect(()=>expandPayrollCompensation({version:1,source:{kind:'batch',sourceId:a}},s)).toThrow(/validated/i);
 s.sourceHeader={status:'validated',batch_type:'reimbursive_travel',is_recurring:false,line_count:1,total_amount:'50.00'};s.sourceLines=[{employee_id:e,km:'10',rate_per_km:'5',value:'50',taxable_portion:'40',non_taxable_portion:'40',effective_from:'2026-10-01',effective_to:null}];
 expect(()=>expandPayrollCompensation({version:1,source:{kind:'batch',sourceId:a}},s)).toThrow(/portion/i);
});
// Ported from payrollBatchService.test.ts, whose postBatch is a delegating shim now.
it('splits a reimbursive travel line into taxable 3702 and non-taxable 3703 assignments',()=>{
 const t='00000000-0000-4000-8000-000000000005',n='00000000-0000-4000-8000-000000000006';
 const s=sources();s.components=[{id:t,sars_source_code:'3702',is_active:true},{id:n,sars_source_code:'3703',is_active:true}];s.assignments=[];
 s.sourceHeader={status:'validated',batch_type:'reimbursive_travel',is_recurring:false,line_count:1,total_amount:'50.00'};
 s.sourceLines=[{employee_id:e,km:'10',rate_per_km:'5',value:'50',taxable_portion:'30',non_taxable_portion:'20',effective_from:'2026-10-01',effective_to:null}];
 const result=expandPayrollCompensation({version:1,source:{kind:'batch',sourceId:a}},s);
 expect(result.payload.actions).toHaveLength(2);
 expect(result.payload.actions.find(x=>x.componentId===t)!.amount).toBe('30.00');
 expect(result.payload.actions.find(x=>x.componentId===n)!.amount).toBe('20.00');
 // Once-off with no ending of its own dies at the end of its OWN month, never the batch period's.
 for(const action of result.payload.actions)expect(action.effectiveTo).toBe('2026-10-31');
});
it('refuses incomplete batch source populations before deriving approved changes',()=>{
 const s=sources();s.sourceHeader={status:'validated',batch_type:'component_values',component_id:c,is_recurring:true,line_count:2,total_amount:'50.00'};
 s.sourceLines=[{employee_id:e,value:'50.00',effective_from:'2026-10-01',effective_to:null}];
 expect(()=>expandPayrollCompensation({version:1,source:{kind:'batch',sourceId:a}},s)).toThrow(/population/i);
});
it('refuses an inactive employee assignment amendment',()=>{
 const s=sources();s.employees[0]!.status='inactive';
 expect(()=>expandPayrollCompensation({version:1,source:{kind:'manual'},actions:[{kind:'amend',assignmentId:a,amount:'50'}]},s)).toThrow(/employee/i);
});
it('allows approved closure of a terminated employee assignment within the employment interval',()=>{
 const s=sources();s.employees[0]!.status='terminated';s.employees[0]!.end_date='2026-10-31';
 const result=expandPayrollCompensation({version:1,source:{kind:'manual'},actions:[{kind:'end',assignmentId:a,effectiveTo:'2026-10-31'}]},s);
 expect(result.amount).toBe('100.00');expect(result.payload.actions[0]!.kind).toBe('end');
});
it('allows closure of an owned deactivated component while refusing new use',()=>{
 const s=sources();s.components[0]!.is_active=false;
 expect(expandPayrollCompensation({version:1,source:{kind:'manual'},actions:[{kind:'end',assignmentId:a,effectiveTo:'2026-10-31'}]},s).payload.actions[0]!.kind).toBe('end');
});
