import { expect,it } from 'vitest';
import { payrollCalculationHashes,assertPayrollCalculationReceipt } from '@/modules/accounting/services/controls/payrollCalculationReceipt';
const sources={header:{period_month:9,period_year:2026,total_gross:'100',total_net:'90',employee_count:1,status:'calculated',updated_at:'old'},
  lines:[{employee_id:'e',gross_pay:'100',net_pay:'90'}],employees:[{id:'e',salary:'100'}],components:[],assignments:[],allocations:[],mappings:[],centres:[],loans:[],loanSchedules:[],loanPayments:[],leaveTypes:[],leaveBalances:[],bankDetails:[],accounts:[],company:{}};
it('refuses unknown legacy calculation coverage',()=>{
  expect(()=>assertPayrollCalculationReceipt(sources,null)).toThrow('recalculate');
});
it('refuses employee inputs changed before approval even when outputs remain the same',()=>{
  const hashes=payrollCalculationHashes(sources);
  expect(()=>assertPayrollCalculationReceipt({...sources,employees:[{id:'e',salary:'101'}]},hashes)).toThrow('recalculate');
});
it('refuses modified persisted output and ignores workflow-only header changes',()=>{
  const hashes=payrollCalculationHashes(sources);
  expect(()=>assertPayrollCalculationReceipt({...sources,header:{...sources.header,total_gross:'101'}},hashes)).toThrow('recalculate');
  expect(()=>assertPayrollCalculationReceipt({...sources,header:{...sources.header,status:'approved',updated_at:'new',journal_entry_id:'journal'}},hashes)).not.toThrow();
});
