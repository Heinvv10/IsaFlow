import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:vi.fn(async()=>null)}));
vi.mock('@/modules/accounting/services/controls/payrollCalculationReceipt',async original=>({
  ...await original<typeof import('@/modules/accounting/services/controls/payrollCalculationReceipt')>(),
  readPayrollCalculationReceipt:async()=>receipt,
}));
import { payrollCalculationHashes, type PayrollCalculationHashes } from '@/modules/accounting/services/controls/payrollCalculationReceipt';
import { materializePayrollOperation } from '@/modules/accounting/services/controls/payrollOperationMaterializer';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
const id='11111111-1111-4111-8111-111111111111';
const ref={entityType:'payroll_run',entityId:id,operation:'payroll_run.post' as const};
let state:Record<string,unknown[]>;
let queries:string[];
let receipt:PayrollCalculationHashes|null;
beforeEach(()=>{
  queries=[];
  state={companies:[{id,default_currency:'ZAR',lockdown_enabled:false,lockdown_date:null}],
    payroll_run_headers:[{id,period_year:2026,period_month:9,status:'calculated',journal_entry_id:null,total_gross:'100',total_paye:'10',total_uif:'2',total_sdl:'1',total_eti:'0',total_net:'89',employee_count:1}],
    payroll_run_lines:[{id:'line',employee_id:'employee',gross_pay:'100',paye:'10',uif_employee:'1',uif_employer:'1',sdl:'1',eti:'0',net_pay:'89'}],
    payroll_employees:[{id:'employee',status:'active',tax_number:'private'}],payroll_components:[{id:'component',is_active:true}],
    payroll_employee_components:[{id:'assignment',employee_id:'employee',component_id:'component',amount:'100'}],
    gl_accounts:['5200','2140','2150','2160','1110'].map(account_code=>({id:account_code,account_code,is_active:true})),
    fiscal_periods:[{id:'period',status:'open',start_date:'2026-09-01',end_date:'2026-09-30'}]};
  receipt=payrollCalculationHashes({header:state.payroll_run_headers![0] as Record<string,unknown>,lines:state.payroll_run_lines as Record<string,unknown>[],
    employees:state.payroll_employees,components:state.payroll_components,assignments:state.payroll_employee_components});
});
const ctx={principal:{companyId:id},sql:async(strings:TemplateStringsArray)=>{
  const query=strings.join('?');queries.push(query);
  const table=query.match(/FROM ([a-z_]+)/)?.[1];return table ? state[table] ?? [] : [];
}} as unknown as ControlTx;
it('binds current employees, component assignments, ledger settings and fiscal period',async()=>{
  const before=await materializePayrollOperation(ctx,ref);
  for (const [table,key,value] of [['payroll_employees','tax_number','changed'],['payroll_employee_components','amount','101'],
    ['companies','default_currency','USD'],['fiscal_periods','status','closed']] as const) {
    const row=state[table]![0] as Record<string,unknown>, prior=row[key];row[key]=value;
    if(table==='payroll_employees' || table==='payroll_employee_components') await expect(materializePayrollOperation(ctx,ref)).rejects.toThrow('recalculate');
    else expect((await materializePayrollOperation(ctx,ref)).binding.sourceVersions).not.toEqual(before.binding.sourceVersions);
    row[key]=prior;
  }
  expect(before.binding).toMatchObject({amount:'102',currency:'ZAR',accountingDate:'2026-09-30'});
});
it('takes the shared payroll fence before source row locks',async()=>{
  await materializePayrollOperation(ctx,ref);
  expect(queries[0]).toContain('pg_advisory_xact_lock');expect(queries[1]).toContain('FROM companies');
});
it('refuses foreign employee and foreign component populations',async()=>{
  state.payroll_employees=[];
  await expect(materializePayrollOperation(ctx,ref)).rejects.toThrow('foreign');
  state.payroll_employees=[{id:'employee'}];state.payroll_components=[];
  await expect(materializePayrollOperation(ctx,ref)).rejects.toThrow('foreign');
});
it('refuses missing ledger currency and ambiguous fiscal coverage',async()=>{
  const company=state.companies![0] as Record<string,unknown>;company.default_currency=null;
  await expect(materializePayrollOperation(ctx,ref)).rejects.toThrow('currency');
  company.default_currency='ZAR';state.fiscal_periods!.push(state.fiscal_periods![0]);
  await expect(materializePayrollOperation(ctx,ref)).rejects.toThrow('ambiguous');
});
it('refuses oversized source populations instead of hashing a truncated subset',async()=>{
  state.payroll_employees=Array.from({length:10001},(_,i)=>({id:i===0?'employee':`employee-${i}`}));
  await expect(materializePayrollOperation(ctx,ref)).rejects.toThrow('population');
});

it('refuses an unverified legacy calculation before requesting approval',async()=>{
  receipt=null;await expect(materializePayrollOperation(ctx,ref)).rejects.toThrow('recalculate');
});
