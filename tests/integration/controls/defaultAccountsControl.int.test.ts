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
it('does not change timestamps or versions on an identical request',async()=>{
 const before=await f.state(),events=await f.changes('accounting_default_accounts',f.f.companyA);
 expect((await f.rest('POST',{mappings:{accounts_receivable:replacement,primary_bank:''}})).status).toBe(200);
 expect(await f.state()).toEqual(before);expect(await f.changes('accounting_default_accounts',f.f.companyA)).toEqual(events);
});
it('preserves null and empty clears while omitted roles are unconfigured',async()=>{
 for(const mappings of [{primary_bank:null},{primary_bank:''},{}]){
  const before=await f.state();expect((await f.rest('POST',{mappings})).status).toBe(200);
  const after=await f.state(),events=await f.changes('accounting_default_accounts',f.f.companyA);
  expect(JSON.parse(after.settings.value)).toEqual(mappings);expect(events.at(-1).values).toEqual({before:before.settings,after:after.settings});
  expect(after.accounts.filter((r:{is_system_account:boolean})=>r.is_system_account)).toEqual([]);
 }
});
it('refuses duplicate roles, unknown keys, invalid IDs, foreign accounts and wrong types without changes',async()=>{
 const foreign=await f.account(f.f.companyB),expense=await f.account(f.f.companyA,'expense');
 for(const mappings of [{primary_bank:replacement,accounts_receivable:replacement.toUpperCase()},{surprise:replacement},{primary_bank:'invalid'},{primary_bank:foreign},{primary_bank:expense}]){
  const before=await f.state(),events=await f.changes('accounting_default_accounts',f.f.companyA),response=await f.rest('POST',{mappings});
  expect(response.status).toBe(400);expect(await f.state()).toEqual(before);expect(await f.changes('accounting_default_accounts',f.f.companyA)).toEqual(events);
 }
});
it('enforces current account write permission and real CSRF before mutation',async()=>{
 const before=await f.state();
 await f.pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,$3,false)',[f.f.companyA,f.f.u1.id,'accounts']);
 try{expect((await f.rest('POST',{mappings:{primary_bank:replacement}})).status).toBe(403);}finally{await f.pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.f.companyA,f.f.u1.id,'accounts']);}
 expect((await f.rest('POST',{mappings:{primary_bank:replacement}},false)).status).toBe(403);expect(await f.state()).toEqual(before);
});
for(const table of ['accounting_settings','gl_accounts','control_protected_evidence','control_change_events']){
 it(`rolls back all state when ${table} suppresses its mandatory write`,async()=>{
  const account=await f.account(),before=await f.state();
  const snapshot=async()=>Promise.all(['control_entity_versions','control_protected_evidence','control_change_events'].map(async t=>(await f.pool.query(`SELECT to_jsonb(t) AS row FROM ${t} t WHERE company_id=$1 ORDER BY entity_type,entity_id`,[f.f.companyA])).rows));
  const history=await snapshot();
  await f.pool.query(`CREATE FUNCTION public.synthetic_default_suppression() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.f.companyA}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  try{await f.pool.query(`CREATE TRIGGER synthetic_default_suppression BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.synthetic_default_suppression()`);
  expect((await f.rest('POST',{mappings:{primary_bank:account}})).status).toBeGreaterThanOrEqual(400);expect(await f.state()).toEqual(before);expect(await snapshot()).toEqual(history);}
  finally{await f.pool.query(`DROP TRIGGER IF EXISTS synthetic_default_suppression ON ${table}`);await f.pool.query('DROP FUNCTION public.synthetic_default_suppression()');}
 });
}
it('captures every old designation beyond a preview page and exposes real authorized history',async()=>{
 const ids=[];for(let i=0;i<105;i++)ids.push(await f.account(f.f.companyA,'asset','bank',true));
 const before=await f.state();expect((await f.rest('POST',{mappings:{}})).status).toBe(200);
 const after=await f.state();for(const id of ids){const changes=await f.changes('gl_account',id);expect(changes).toHaveLength(1);expect(changes[0].values).toEqual({before:before.accounts.find((r:{id:string})=>r.id===id),after:after.accounts.find((r:{id:string})=>r.id===id)});}
 const {readControlEntityHistory}=await import('@/modules/accounting/services/controls/controlChangeHistoryService');
 const read=()=>f.actor(ctx=>readControlEntityHistory(ctx,{entityType:'accounting_default_accounts',entityId:f.f.companyA}));
 const result=await read(),retained=await f.changes('accounting_default_accounts',f.f.companyA);
 expect(result.items).toHaveLength(retained.length);expect(result.items[0]!.before).toEqual(retained[0].values.before);
 expect(result.items.at(-1)?.after).toEqual(after.settings);expect(result.items.at(-1)?.newVersion).toBe(Number(retained.at(-1).new_version));
 await f.pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[f.f.companyA,f.f.u1.id,'reports']);
 try{await expect(read()).rejects.toThrow();}finally{await f.pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.f.companyA,f.f.u1.id,'reports']);}
});
it('serializes simultaneous settings and ordinary chart updates with consecutive exact images',async()=>{
 const id=await f.account(),{saveDefaultAccounts}=await import('@/modules/accounting/services/gl/defaultAccountsControl'),{updateAccount}=await import('@/modules/accounting/services/gl/chartOfAccountsService');
 await Promise.all([f.actor(ctx=>saveDefaultAccounts(ctx,{mappings:{primary_bank:id}})),f.actor(()=>updateAccount(f.f.companyA,id,{accountName:'Concurrent chart name'}))]);
 const state=await f.state(),row=state.accounts.find((r:{id:string})=>r.id===id),events=await f.changes('gl_account',id);
 expect(row).toMatchObject({account_name:'Concurrent chart name',account_subtype:'bank',is_system_account:true});expect(events).toHaveLength(2);
 expect(events[0].values.after).toEqual(events[1].values.before);expect(events[1].values.after).toEqual(row);
});
it('requires issued context and detaches input before the first awaited authority read',async()=>{
 const {saveDefaultAccounts}=await import('@/modules/accounting/services/gl/defaultAccountsControl'),id=await f.account(),input:{mappings:{primary_bank:string}}={mappings:{primary_bank:id}};
 await expect(saveDefaultAccounts({} as Parameters<typeof saveDefaultAccounts>[0],input)).rejects.toThrow();
 await f.actor(async ctx=>{const pending=saveDefaultAccounts(ctx,input);input.mappings.primary_bank='invalid';await pending;});
 expect(JSON.parse((await f.state()).settings.value)).toEqual({primary_bank:id});
});
it('refuses whole-map changes when an existing designation is outside current account constraints',async()=>{
 const id=await f.account(),code=(await f.pool.query('SELECT account_code FROM gl_accounts WHERE company_id=$1 AND id=$2',[f.f.companyA,id])).rows[0].account_code,before=await f.state();
 await f.pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write,account_range_from,account_range_to,restrictions) VALUES($1,$2,$3,true,$4,$4,$5::jsonb)',[f.f.companyA,f.f.u1.id,'accounts',code,'{}']);
 try{const {saveDefaultAccounts}=await import('@/modules/accounting/services/gl/defaultAccountsControl');await expect(f.actor(ctx=>saveDefaultAccounts(ctx,{mappings:{primary_bank:id}}))).rejects.toThrow('Current permissions');expect(await f.state()).toEqual(before);}
 finally{await f.pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.f.companyA,f.f.u1.id,'accounts']);}
});
