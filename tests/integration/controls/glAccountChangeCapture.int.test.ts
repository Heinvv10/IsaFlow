import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,changes,glFixture,legacy,pool} from './glAccountChangeFixture';
import {createAccount,renameAccountCode,updateAccount,deleteAccount,seedChartOfAccountsFromTemplate} from '@/modules/accounting/services/gl/chartOfAccountsService';
import {reclassifyAccount} from '@/modules/accounting/services/gl/accountReclassifyService';
const input=()=>({accountCode:randomUUID().slice(0,12),accountName:'Synthetic exact account',accountType:'asset' as const,normalBalance:'debit' as const});
it('captures actual create, rename, edit and deactivate with exact rows and consecutive versions',async()=>{
 const f=glFixture(),created=await actor(()=>createAccount(f.companyA,input()),'u1',true);
 const first=await changes(created.id);expect(first).toHaveLength(1);expect(first[0].values.before).toBeNull();
 expect(first[0].values.after).toMatchObject({id:created.id,account_name:created.accountName,company_id:f.companyA});
 expect(first[0].connection_id).toBe(f.u1.tokens[0]!.id);expect(first[0].values.after?.created_at).toBeTruthy();
 await actor(()=>renameAccountCode(f.companyA,created.id,randomUUID().slice(0,12)));
 await actor(()=>updateAccount(f.companyA,created.id,{accountName:'Changed name',description:'exact description',vatInputDenied:true,defaultVatCode:'exempt'}));
 await actor(()=>deleteAccount(f.companyA,created.id));
 const all=await changes(created.id);expect(all.map(row=>Number(row.new_version))).toEqual([1,2,3,4]);
 expect(all[2].values.after).toMatchObject({account_name:'Changed name',vat_input_denied:true,default_vat_code:'exempt'});
 expect(all[3].values.after?.is_active).toBe(false);expect(all[3].values.before).toEqual(all[2].values.after);
});
it('retains real legacy before and does not record repeated no-ops',async()=>{
 const f=glFixture(),id=await legacy();
 await actor(()=>updateAccount(f.companyA,id,{accountName:'New legacy name'}));
 const first=await changes(id);expect(first).toHaveLength(1);expect(first[0].previous_version).toBeNull();expect(first[0].values.before?.account_name).toBe('Synthetic legacy GL');
 await actor(()=>updateAccount(f.companyA,id,{accountName:'New legacy name'}));
 await actor(()=>reclassifyAccount(f.companyA,id,{parentAccountId:null}));
 expect(await changes(id)).toHaveLength(1);
});
it('captures the changed subtree and leaves unrelated descendants alone',async()=>{
 const f=glFixture(),root=await legacy(),child=await legacy(root,2),grandchild=await legacy(child,3),other=await legacy();
 await actor(()=>reclassifyAccount(f.companyA,child,{parentAccountId:null}));
 for(const [id,before,after] of [[child,2,1],[grandchild,3,2]] as const){const rows=await changes(id);expect(rows).toHaveLength(1);expect(rows[0].values.before?.level).toBe(before);expect(rows[0].values.after?.level).toBe(after);}
 expect(await changes(root)).toEqual([]);expect(await changes(other)).toEqual([]);
});
it('refuses foreign, missing issued context and revoked current authority before writes',async()=>{
 const f=glFixture(),id=await legacy(null,1,f.companyB);
 await expect(actor(()=>updateAccount(f.companyA,id,{accountName:'Foreign'}))).rejects.toThrow();
 await expect(createAccount(f.companyA,input())).rejects.toThrow();
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'accounts',false)",[f.companyA,f.u1.id]);
 try{await expect(actor(()=>createAccount(f.companyA,input()),'u1',true)).rejects.toThrow();}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='accounts'",[f.companyA,f.u1.id]);}
 expect(await changes(id,f.companyB)).toEqual([]);
});
it('serializes concurrent edits with exact preceding before-images',async()=>{
 const f=glFixture(),id=await legacy();
 await Promise.all([actor(()=>updateAccount(f.companyA,id,{accountName:'Concurrent A'})),actor(()=>updateAccount(f.companyA,id,{description:'Concurrent B'}),'u2')]);
 const rows=await changes(id);expect(rows).toHaveLength(2);expect(rows[1].values.before).toEqual(rows[0].values.after);expect(rows[1].values.after).toMatchObject({account_name:'Concurrent A',description:'Concurrent B'});
});
it('records template final parents once and emits no events on identical reseed',async()=>{
 const f=glFixture();await actor(()=>seedChartOfAccountsFromTemplate(f.companyB,'isaflow_standard'),'u3');
 const accounts=(await pool.query('SELECT id,parent_account_id FROM gl_accounts WHERE company_id=$1',[f.companyB])).rows;
 for(const account of accounts){const rows=await changes(account.id,f.companyB);if(rows.length){expect(rows).toHaveLength(1);expect(rows[0].values.after?.parent_account_id).toBe(account.parent_account_id);}}
 const count=Number((await pool.query("SELECT count(*) FROM control_change_events WHERE company_id=$1 AND entity_type='gl_account'",[f.companyB])).rows[0].count);expect(count).toBeGreaterThan(50);
 await actor(()=>seedChartOfAccountsFromTemplate(f.companyB,'isaflow_standard'),'u3');
 expect(Number((await pool.query("SELECT count(*) FROM control_change_events WHERE company_id=$1 AND entity_type='gl_account'",[f.companyB])).rows[0].count)).toBe(count);
});
