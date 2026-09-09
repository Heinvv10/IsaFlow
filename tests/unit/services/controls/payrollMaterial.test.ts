import { expect, it } from 'vitest';
import { buildExactPayrollPlan } from '@/modules/accounting/services/controls/payrollExactPlan';
const header={total_gross:'100.00',total_paye:'10.00',total_uif:'2.00',total_sdl:'1.00',total_eti:'0.00',total_net:'89.00',employee_count:1};
const lines=[{employee_id:'e1',gross_pay:'100.00',paye:'10.00',uif_employee:'1.00',uif_employer:'1.00',sdl:'1.00',eti:'0.00',net_pay:'89.00'}];
const accounts=['5200','2140','2150','2160','1110','2175'].map(account_code=>({id:account_code,account_code,is_active:true}));
const build=(h=header,l=lines)=>buildExactPayrollPlan(h,l,accounts,[],[],[]);
it('derives exact balanced journal amounts from reconciled header and employee lines',()=>{
  const plan=build();expect(plan.amount).toBe('102');expect(plan.lines.find(l=>l.glAccountId==='1110')?.credit).toBe('89');
});
it('refuses invented header totals and missing run populations',()=>{
  expect(()=>build({...header,total_gross:'101.00'})).toThrow('reconcile');
  expect(()=>build(header,[])).toThrow();
});
it('refuses unbalanced ETI rather than inventing a statutory offset',()=>{
  expect(()=>build({...header,total_eti:'1.00'},[{...lines[0]!,eti:'1.00'}])).toThrow('balanced');
});
it('preserves large exact money without Number conversion',()=>{
  const value='9007199254740993.01';
  const h={...header,total_gross:value,total_net:value,total_paye:'0',total_uif:'0',total_sdl:'0'};
  const l=[{...lines[0]!,gross_pay:value,net_pay:value,paye:'0',uif_employee:'0',uif_employer:'0',sdl:'0'}];
  expect(build(h,l).amount).toBe(value);
});
it('rejects negative employee money and ambiguous/inactive account mappings',()=>{
  expect(()=>build(header,[{...lines[0]!,net_pay:'-1'}])).toThrow();
  expect(()=>buildExactPayrollPlan(header,lines,[...accounts,accounts[0]!],[],[],[])).toThrow('account');
  expect(()=>buildExactPayrollPlan(header,lines,accounts.map(a=>({...a,is_active:false})),[],[],[])).toThrow('account');
});
it('allocates exact cents deterministically across employee cost centres',()=>{
  const plan=buildExactPayrollPlan(header,lines,[...accounts,{id:'expense',account_code:'5300',is_active:true}],
    [{id:'e1',cost_centre_id:'c1'}],[{employee_id:'e1',cost_centre_id:'c1',percentage:'33.33'},{employee_id:'e1',cost_centre_id:'c2',percentage:'66.67'}],
    [{cost_centre_id:'c1',expense_account_id:'expense'}]);
  expect(plan.lines.find(l=>l.glAccountId==='expense')?.debit).toBe('34');
  expect(plan.lines.find(l=>l.glAccountId==='5200')?.debit).toBe('68');
});
