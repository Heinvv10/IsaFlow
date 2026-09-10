import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {openProtectedChange} from '@/modules/accounting/services/controls/changeProtection';
import {glEightFixture} from './glEightFixture';
import {createAccount,updateAccount} from '@/modules/accounting/services/gl/chartOfAccountsService';
import {getPostedAccountBalance} from '@/modules/accounting/services/gl/glAccountBalance';
let f:Awaited<ReturnType<typeof glEightFixture>>;
beforeAll(async()=>{f=await glEightFixture();},30000);afterAll(async()=>{if(f)await f.close();});
const balanceQueries=(queries:string[])=>queries.filter(q=>/debit_total/i.test(q));
async function row(id:string){return(await f.pool.query('SELECT * FROM gl_accounts WHERE company_id=$1 AND id=$2',[f.f.companyA,id])).rows[0];}
for(const [signed,message] of [[130000,'130000.00'],[-450,'-450.00']] as const){
 it(`refuses a posted ${signed} balance with named money and no account, journal or audit mutation`,async()=>{
  const id=await f.account();await f.post(id,signed);const before=await f.state(),queries:string[]=[];
  await expect(f.actor(()=>updateAccount(f.f.companyA,id,{isActive:false}),queries)).rejects.toThrow(`GL balance is R ${message}`);
  await expect(f.actor(()=>updateAccount(f.f.companyA,id,{isActive:false}))).rejects.toThrow('Loan Account - Blitz Fibre');
  expect(balanceQueries(queries)).toHaveLength(1);expect(queries.some(q=>/UPDATE gl_accounts/i.test(q))).toBe(false);
  expect(await f.state()).toEqual(before);
 });
}
it('deactivates an actually posted and reconciled zero balance and records one exact change',async()=>{
 const id=await f.account();await f.post(id,5000);await f.post(id,-5000);
 expect(await f.actor(()=>getPostedAccountBalance(f.f.companyA,id))).toBe(0);
 const before=JSON.parse(JSON.stringify(await row(id)));
 await f.actor(()=>updateAccount(f.f.companyA,id,{isActive:false}));const after=JSON.parse(JSON.stringify(await row(id)));expect(after.is_active).toBe(false);
 const events=(await f.pool.query("SELECT e.action,e.previous_version,e.new_version,p.envelope_version,p.key_id,p.ciphertext FROM control_change_events e JOIN control_protected_evidence p ON p.company_id=e.company_id AND p.id=e.protected_evidence_id WHERE e.company_id=$1 AND e.entity_type='gl_account' AND e.entity_id=$2 ORDER BY e.new_version",[f.f.companyA,id])).rows;
 expect(events.map(e=>({action:e.action,previous:e.previous_version,version:e.new_version}))).toEqual([{action:'baseline_observed',previous:null,version:'1'},{action:'updated',previous:'1',version:'2'}]);
 const event=events[1];expect(openProtectedChange({version:event.envelope_version,keyId:event.key_id,ciphertext:event.ciphertext})).toEqual({before,after});
});
it('reactivates a legacy inactive account holding money without a balance query',async()=>{
 const id=await f.account();await f.post(id,130000);
 await f.pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[f.f.companyA,id]);
 const queries:string[]=[];await f.actor(()=>updateAccount(f.f.companyA,id,{isActive:true}),queries);
 expect((await row(id)).is_active).toBe(true);expect(balanceQueries(queries)).toEqual([]);
 expect(await f.actor(()=>getPostedAccountBalance(f.f.companyA,id))).toBe(130000);
});
it('renames an account holding money without checking or changing its balance',async()=>{
 const id=await f.account();await f.post(id,130000);const queries:string[]=[];
 await f.actor(()=>updateAccount(f.f.companyA,id,{accountName:'Renamed'}),queries);
 expect((await row(id)).account_name).toBe('Renamed');expect(balanceQueries(queries)).toEqual([]);
 expect(await f.actor(()=>getPostedAccountBalance(f.f.companyA,id))).toBe(130000);
});
it('refuses a system account before reading its balance and leaves all state unchanged',async()=>{
 const id=await f.account({system:true}),before=await f.state(),queries:string[]=[];
 await expect(f.actor(()=>updateAccount(f.f.companyA,id,{isActive:false}),queries)).rejects.toThrow(/system account/i);
 expect(balanceQueries(queries)).toEqual([]);expect(await f.state()).toEqual(before);
});
it('requires a subtype for an authorized expense create without persisting any account or event',async()=>{
 const before=await f.state();await expect(f.actor(()=>createAccount(f.f.companyA,{accountCode:'5999',accountName:'Sundry',accountType:'expense',normalBalance:'debit'}))).rejects.toThrow(/subtype.*required/i);
 expect(await f.state()).toEqual(before);
});
it('creates an authorized expense with an explicit subtype and retained change event',async()=>{
 const created=await f.actor(()=>createAccount(f.f.companyA,{accountCode:randomUUID().slice(0,12),accountName:'Sundry',accountType:'expense',normalBalance:'debit',accountSubtype:'operating_expense'}));
 expect((await row(created.id)).account_subtype).toBe('operating_expense');
 expect((await f.pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_type='gl_account' AND entity_id=$2",[f.f.companyA,created.id])).rows).toHaveLength(1);
});
it('refuses a foreign-owned account without changing either tenant account',async()=>{
 const id=await f.account({company:f.f.companyB}),before=await f.state();
 await expect(f.actor(()=>updateAccount(f.f.companyA,id,{isActive:false}))).rejects.toThrow();
 expect(await f.state()).toEqual(before);
 expect((await f.pool.query('SELECT is_active FROM gl_accounts WHERE company_id=$1 AND id=$2',[f.f.companyB,id])).rows).toEqual([{is_active:true}]);
});
