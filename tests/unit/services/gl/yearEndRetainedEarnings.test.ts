/** Retained earnings must be resolved from the owned system role, never a label/code guess. */
import {describe,it,expect,vi} from 'vitest';
import {buildYearEndFinancialMaterial} from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const companyId='11111111-1111-4111-8111-111111111111';
const retained=(id:string,code:string)=>({id,account_code:code,account_name:'Retained Earnings',account_type:'equity',is_active:true});
function setup(rows:Record<string,unknown>[]){
 const sql=vi.fn(async()=>rows);
 const ctx={principal:{companyId},sql} as unknown as ControlTx;
 const source={company:{default_currency:'ZAR',financial_year_start:3},periods:[{start_date:'2025-03-01',end_date:'2026-02-28'}],
  journals:[{id:'posted',status:'posted'}],lines:[{journal_entry_id:'posted',gl_account_id:'sales',debit:'0',credit:'1000'}],accounts:[{id:'sales',account_type:'revenue'}]};
 return {sql,run:()=>buildYearEndFinancialMaterial(ctx,'2026',source)};
}
describe('year-end retained earnings source',()=>{
 it('resolves a single owned system role and balances the actual closing plan',async()=>{
  const {sql,run}=setup([retained('retained','SYS11')]);
  const result=await run();
  expect(result.plan).toEqual([{glAccountId:'sales',debit:'1000',credit:'0'},{glAccountId:'retained',debit:'0',credit:'1000'}]);
  const [parts,...params]=sql.mock.calls[0] as unknown as [string[],...unknown[]];
  expect(parts.join('?')).toMatch(/company_id=.*is_system_account=true[\s\S]*account_subtype='retained_earnings'/);
  expect(params).toContain(companyId);
 });
 it('never matches account names, code defaults, or unscoped app settings',async()=>{
  const {sql,run}=setup([retained('retained','CUSTOM')]);await run();
  const text=(sql.mock.calls[0] as unknown as [string[]])[0].join('?');
  expect(text).not.toMatch(/account_name\s+I?LIKE|app_settings|account_code\s*=/i);
  expect(sql.mock.calls.flat()).not.toContain('3200');
 });
 it('preserves the missing-role diagnostic before any write',async()=>{
  await expect(setup([]).run()).rejects.toMatchObject({result:{error:'no_retained_earnings'}});
 });
 it.each([2,3])('preserves all candidate codes for %i contested roles',async(count)=>{
  const rows=Array.from({length:count},(_,i)=>retained(`retained-${i}`,`320${i}`));
  await expect(setup(rows).run()).rejects.toMatchObject({result:{error:'ambiguous_retained_earnings',accountCodes:rows.map(r=>r.account_code)}});
 });
 it('refuses a role assigned to a non-equity account',async()=>{
  await expect(setup([{...retained('retained','3200'),account_type:'expense'}]).run()).rejects.toThrow('Retained earnings');
 });
});
