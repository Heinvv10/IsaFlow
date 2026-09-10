import {beforeAll,afterAll,expect,it} from 'vitest';
import {defaultAccountsFixture} from './defaultAccountsFixture';
let f:Awaited<ReturnType<typeof defaultAccountsFixture>>,old:string,replacement:string;
beforeAll(async()=>{
 f=await defaultAccountsFixture();old=await f.account(f.f.companyA,'asset','receivable',true);replacement=await f.account();
 await f.pool.query("INSERT INTO app_settings(company_id,key,value) VALUES($1,'accounting_default_accounts',$2::jsonb)",[f.f.companyA,JSON.stringify({accounts_receivable:old})]);
},30000);afterAll(async()=>{if(f)await f.close();});
it('captures the actual existing POST settings and every changed account row',async()=>{
 const before=await f.state(),response=await f.rest('POST',{mappings:{accounts_receivable:replacement,primary_bank:''}});
 expect(response.status).toBe(200);expect(response.body.data).toMatchObject({saved:true});
 const after=await f.state(),events=await f.changes('accounting_default_accounts',f.f.companyA);
 expect(typeof after.settings.value==='string'?JSON.parse(after.settings.value):after.settings.value).toEqual({accounts_receivable:replacement,primary_bank:''});
 expect(after.accounts.find((r:{id:string})=>r.id===old).is_system_account).toBe(false);
 expect(after.accounts.find((r:{id:string})=>r.id===replacement)).toMatchObject({is_system_account:true,account_subtype:'receivable'});
 expect(events).toHaveLength(1);expect(events[0].previous_version).toBeNull();expect(Number(events[0].new_version)).toBe(1);
 expect(events[0].values).toEqual({before:before.settings,after:after.settings});expect(events[0].action).toBe('default_accounts_changed');
 for(const id of [old,replacement]){const rows=await f.changes('gl_account',id);expect(rows).toHaveLength(1);expect(rows[0].values).toEqual({before:before.accounts.find((r:{id:string})=>r.id===id),after:after.accounts.find((r:{id:string})=>r.id===id)});}
 expect(events[0].person_id).toBe(f.f.u1.id);expect(events[0].connection_id).toBeNull();expect(events[0].provenance).toBe('human');
});
