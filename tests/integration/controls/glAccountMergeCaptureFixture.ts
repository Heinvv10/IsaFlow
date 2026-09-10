import {beforeAll} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,glFixture,pool,legacy} from './glAccountChangeFixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {mergeAccounts} from '@/modules/accounting/services/gl/accountMergeService';
import {openProtectedChange} from '@/modules/accounting/services/controls/changeProtection';
export {actor,glFixture,pool,legacy};
let period:string;
beforeAll(async()=>{
 period=randomUUID();await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic merge September',9,2026,'2026-09-01','2026-09-30','open')",[period,glFixture().companyA]);
});
export async function mergeFixture(status='posted'){
 const f=glFixture(),source=await legacy(),target=await legacy(),contra=await legacy(),journal=randomUUID();
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,description,source,status,created_by) VALUES($1,$2,'2026-09-10',$3,'Synthetic merge journal','manual',$4,$5)",[journal,f.companyA,period,status,f.u1.id]);
 await pool.query("INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description) VALUES($1,$2,$3,123.45,0,'source debit'),($1,$2,$4,50.25,0,'original target debit'),($1,$2,$5,0,173.70,'unmoved contra')",[f.companyA,journal,source,target,contra]);
 return{source,target,contra,journal,period};
}
export const merge=(source:string,target:string)=>actor(ctx=>mergeAccounts(ctx.principal.companyId,source,target,ctx.principal.personId));
export async function journalRows(id:string){
 const f=glFixture();return(await pool.query('SELECT id,gl_account_id,debit::text,credit::text,description FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 ORDER BY id',[f.companyA,id])).rows;
}
export async function evidence(type:string,id:string){
 const rows=(await pool.query("SELECT e.action,e.binding_hash,e.accounting_date::text,e.previous_version,e.new_version,p.ciphertext,p.key_id,p.envelope_version FROM control_change_events e JOIN control_protected_evidence p ON p.company_id=e.company_id AND p.id=e.protected_evidence_id AND p.entity_type=e.entity_type AND p.entity_id=e.entity_id WHERE e.company_id=$1 AND e.entity_type=$2 AND e.entity_id=$3 ORDER BY e.new_version",[glFixture().companyA,type,id])).rows;
 return rows.map(row=>({...row,values:openProtectedChange({version:row.envelope_version,keyId:row.key_id,ciphertext:row.ciphertext})}));
}

export async function patMerge(source:string,target:string){
 const f=glFixture(),user=f.u1,token=user.tokens[0]!,client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:f.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),f.companyA]);
  const result=await withControlRequest({client,userId:user.id,companyId:f.companyA,claims},{personId:user.id,companyId:f.companyA,authMethod:'pat',connectionId:token.id,grantId:token.id,grantedScopes:['read:reports','write:accounts','write:post']},()=>mergeAccounts(f.companyA,source,target,requireControlTx().principal.personId));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
