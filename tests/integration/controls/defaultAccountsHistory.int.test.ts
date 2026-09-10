import {expect,it} from 'vitest';
import {actor,historyFixture,pool} from './controlChangeHistoryFixture';
import {readControlEntityHistory} from '@/modules/accounting/services/controls/controlChangeHistoryService';
import {recordCommittedChange} from '@/modules/accounting/services/controls/changeEventService';
const family='accounting_default_accounts';
it('reports owned pre-capture settings as untracked and retains the exact settings row shape',async()=>{
 const f=historyFixture(),id=f.companyA;
 const initial=await actor(ctx=>readControlEntityHistory(ctx,{entityType:family,entityId:id}));
 expect(initial.coverage.historical).toBe('untracked');expect(initial.items).toEqual([]);
 const before={company_id:id,key:family,value:'{"primary_bank":""}'},after={...before,value:'{"primary_bank":null}'};
 await actor(ctx=>recordCommittedChange(ctx,{entityType:family,entityId:id,previousVersion:null,newVersion:1,
  action:'default_accounts_changed',accountingDate:null,before,after,bindingHash:null,protectedEvidenceRef:null}));
 const retained=await actor(ctx=>readControlEntityHistory(ctx,{entityType:family,entityId:id}));
 expect(retained.items[0]).toMatchObject({before,after,newVersion:1,accountingDate:null});
});
it('requires current audit and reporting access and refuses foreign company identity',async()=>{
 const f=historyFixture(),read=()=>actor(ctx=>readControlEntityHistory(ctx,{entityType:family,entityId:f.companyA}));
 for(const moduleKey of ['audit','reports']){
  await pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[f.companyA,f.u1.id,moduleKey]);
  try{await expect(read()).rejects.toThrow();}
  finally{await pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.companyA,f.u1.id,moduleKey]);}
 }
 await expect(actor(ctx=>readControlEntityHistory(ctx,{entityType:family,entityId:f.companyA}),'u3')).rejects.toThrow();
 expect((await read()).items).toHaveLength(1);
});
