import {expect,it} from 'vitest';
import {recordCommittedChange} from '@/modules/accounting/services/controls/changeEventService';
import {actor,changes,glFixture,legacy,pool} from './glAccountChangeFixture';

for(const table of ['control_protected_evidence','control_change_events'] as const){
 it(`refuses a suppressed ${table} INSERT even when the caller catches the error`,async()=>{
  const f=glFixture(),id=await legacy(),errors:string[]=[];
  const message=table==='control_protected_evidence'?'Mandatory protected evidence INSERT was not retained':'Mandatory change event INSERT was not retained';
  await pool.query(`CREATE FUNCTION public.synthetic_change_insert_suppression() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.companyA}'::uuid AND NEW.entity_type='gl_account' AND NEW.entity_id='${id}' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER synthetic_change_insert_suppression BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.synthetic_change_insert_suppression()`);
  try{
   await expect(actor(async ctx=>{
    await ctx.sql`UPDATE gl_accounts SET account_name='Uncommitted change' WHERE company_id=${f.companyA}::uuid AND id=${id}::uuid`;
    try{await recordCommittedChange(ctx,{entityType:'gl_account',entityId:id,previousVersion:null,newVersion:1,action:'updated',accountingDate:null,
     before:{account_name:'Synthetic legacy GL'},after:{account_name:'Uncommitted change'},bindingHash:null,protectedEvidenceRef:null});}
    catch(error){errors.push(error instanceof Error?error.message:String(error));}
   })).rejects.toThrow();
   expect(errors).toEqual([message]);
   expect((await pool.query('SELECT account_name FROM gl_accounts WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0].account_name).toBe('Synthetic legacy GL');
   for(const ownedTable of ['control_entity_versions','control_protected_evidence','control_change_events']){
    expect((await pool.query(`SELECT entity_id FROM ${ownedTable} WHERE company_id=$1 AND entity_type='gl_account' AND entity_id=$2`,[f.companyA,id])).rows).toEqual([]);
   }
  }finally{await pool.query(`DROP TRIGGER IF EXISTS synthetic_change_insert_suppression ON ${table}`);await pool.query('DROP FUNCTION IF EXISTS public.synthetic_change_insert_suppression()');}
 });
}
it('retains normal exact protected evidence and event identity with the domain mutation',async()=>{
 const f=glFixture(),id=await legacy();
 const result=await actor(async ctx=>{
  await ctx.sql`UPDATE gl_accounts SET account_name='Committed change' WHERE company_id=${f.companyA}::uuid AND id=${id}::uuid`;
  return recordCommittedChange(ctx,{entityType:'gl_account',entityId:id,previousVersion:null,newVersion:1,action:'updated',accountingDate:null,
   before:{account_name:'Synthetic legacy GL'},after:{account_name:'Committed change'},bindingHash:null,protectedEvidenceRef:null});
 });
 const rows=await changes(id);expect(rows).toHaveLength(1);expect(rows[0].id).toBe(result.eventId);
 expect(rows[0].values).toEqual({before:{account_name:'Synthetic legacy GL'},after:{account_name:'Committed change'}});
 expect((await pool.query('SELECT account_name FROM gl_accounts WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0].account_name).toBe('Committed change');
});
