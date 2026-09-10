import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,changes,glFixture,legacy,pool} from './glAccountChangeFixture';
import {createAccount,renameAccountCode,updateAccount,deleteAccount,seedChartOfAccountsFromTemplate} from '@/modules/accounting/services/gl/chartOfAccountsService';
import {getTemplateLines} from '@/modules/accounting/services/gl/chartOfAccountsImportService';
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
 const codes=getTemplateLines('isaflow_standard').map(row=>row.code);
 const accounts=(await pool.query('SELECT id,parent_account_id FROM gl_accounts WHERE company_id=$1 AND account_code=ANY($2::text[])',[f.companyB,codes])).rows;expect(accounts).toHaveLength(codes.length);
 for(const account of accounts){const rows=await changes(account.id,f.companyB);expect(rows).toHaveLength(1);expect(rows[0].values.after?.parent_account_id).toBe(account.parent_account_id);}
 const count=Number((await pool.query("SELECT count(*) FROM control_change_events WHERE company_id=$1 AND entity_type='gl_account'",[f.companyB])).rows[0].count);expect(count).toBeGreaterThan(50);
 await actor(()=>seedChartOfAccountsFromTemplate(f.companyB,'isaflow_standard'),'u3');
 expect(Number((await pool.query("SELECT count(*) FROM control_change_events WHERE company_id=$1 AND entity_type='gl_account'",[f.companyB])).rows[0].count)).toBe(count);
});

it('rolls back real account mutation when mandatory event insertion fails even if caller catches',async()=>{
 const f=glFixture(),id=await legacy();
 await pool.query(`CREATE FUNCTION public.synthetic_gl_capture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.companyA}'::uuid AND NEW.entity_type='gl_account' AND NEW.entity_id='${id}' THEN RAISE EXCEPTION 'Synthetic mandatory event failure'; END IF; RETURN NEW; END $$`);
 await pool.query('CREATE TRIGGER synthetic_gl_capture_failure BEFORE INSERT ON control_change_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_gl_capture_failure()');
 try{
  await expect(actor(async()=>{try{await updateAccount(f.companyA,id,{accountName:'Must roll back'});}catch(error){expect(error).toBeInstanceOf(Error);}})).rejects.toThrow();
  expect((await pool.query('SELECT account_name FROM gl_accounts WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0].account_name).toBe('Synthetic legacy GL');expect(await changes(id)).toEqual([]);
  expect((await pool.query("SELECT count(*) FROM control_entity_versions WHERE company_id=$1 AND entity_type='gl_account' AND entity_id=$2",[f.companyA,id])).rows[0].count).toBe('0');
 }finally{await pool.query('DROP TRIGGER IF EXISTS synthetic_gl_capture_failure ON control_change_events');await pool.query('DROP FUNCTION IF EXISTS public.synthetic_gl_capture_failure()');}
});
it('enforces existing account ranges across descendants and refuses constrained new-account creation',async()=>{
 const f=glFixture(),root=await legacy(),child=await legacy(root,2);
 await pool.query("UPDATE gl_accounts SET account_code=CASE WHEN id=$2 THEN '1001' ELSE '2001' END WHERE company_id=$1 AND id=ANY($3::uuid[])",[f.companyA,root,[root,child]]);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write,account_range_from,account_range_to,restrictions) VALUES($1,$2,'accounts',true,true,'1000','1999','{}'::jsonb)",[f.companyA,f.u2.id]);
 try{
  await actor(()=>updateAccount(f.companyA,root,{description:'Allowed in range'}),'u2');
  await expect(actor(()=>updateAccount(f.companyA,child,{description:'Outside range'}),'u2')).rejects.toThrow();
  const parent=await legacy();await expect(actor(()=>reclassifyAccount(f.companyA,root,{parentAccountId:parent}),'u2')).rejects.toThrow();
  await expect(actor(()=>createAccount(f.companyA,{...input(),accountCode:'1500'}),'u2')).rejects.toThrow();
  expect(await changes(root)).toHaveLength(1);expect(await changes(child)).toEqual([]);
 }finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='accounts'",[f.companyA,f.u2.id]);}
});
it('detaches caller inputs before awaits and never invokes accessors',async()=>{
 const f=glFixture(),data=input();let accesses=0;
 const created=await actor(()=>{const pending=createAccount(f.companyA,data);data.accountName='Changed after call';return pending;});expect(created.accountName).toBe('Synthetic exact account');
 const malicious={...input(),get accountName(){accesses++;return 'Getter';}};
 await expect(actor(()=>createAccount(f.companyA,malicious))).rejects.toThrow();expect(accesses).toBe(0);
});
