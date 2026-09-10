import {writeFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {storeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {executeHistoricalImport} from '@/modules/accounting/services/controls/historicalImportExecution';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:10000});
let fixture:ForensicFixture;
async function actor<T>(person:'u1'|'u2',fn:(ctx:ControlTx)=>Promise<T>){
 const client=await pool.connect(),user=fixture[person];
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
   {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic request did not commit');
  return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function setup(){
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 for(const [code,type,subtype,normal] of [['CASE-D','asset','receivable','debit'],['CASE-C','revenue','default_revenue','credit']])
  await pool.query('INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level,is_system_account) VALUES($1,$2,$2,$3,$4,$5,true,3,true)',[fixture.companyA,code,type,subtype,normal]);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'Synthetic case replay',3,2023,'2023-03-01','2023-03-31','open')",[fixture.companyA]);
}

async function prepared():Promise<OperationRef>{
 const sourceKey=randomUUID();
 const body={version:1,sourceSystem:'csv',sourceKey,kind:'gl',mode:'post_journal',accountingDate:'2023-03-01',currency:'ZAR',records:[
  {recordId:'1',accountCode:'CASE-D',debit:'10',credit:'0',description:'Synthetic debit'},
  {recordId:'2',accountCode:'CASE-C',debit:'0',credit:'10',description:'Synthetic credit'}]};
 const source=await actor('u1',ctx=>storeHistoricalImportSource(ctx,{bytes:Buffer.from(JSON.stringify(body)),mimeType:'application/json'}));
 const saved=await actor('u1',ctx=>prepareHistoricalImport(ctx,{sourceSystem:'csv',sourceKey,kind:'gl',mode:'post_journal',accountingDate:'2023-03-01',evidenceId:source.sourceId,sourceRecordIds:['1','2']}));
 if(saved.importId.toUpperCase()===saved.importId)throw new Error('Synthetic UUID lacks case distinction');
 return{entityType:'historical_import',entityId:saved.importId,operation:'historical_import.post'};
}
async function approved(ref:OperationRef){
 const approval=await actor('u1',ctx=>requestOperationApproval(ctx,ref));
 await actor('u2',ctx=>decideOperationApproval(ctx,approval.id,'approved'));
 return approval.id;
}
// This runner must execute from the independently selected baseline worktree.
async function seed(){
 const output=process.argv[2];if(!output)throw new Error('Synthetic artifact output required');
 await setup();const ref=await prepared(),upper={...ref,entityId:ref.entityId.toUpperCase()};
 const approval=await approved(upper),result=await actor('u1',ctx=>executeHistoricalImport(ctx,upper,approval));
 if(result.importId!==upper.entityId)throw new Error('Baseline did not preserve uppercase identity');
 const identities={companyA:fixture.companyA,u1:{id:fixture.u1.id,companyId:fixture.u1.companyId},u2:{id:fixture.u2.id,companyId:fixture.u2.companyId}};
 await writeFile(output,JSON.stringify({fixture:identities,ref,result,approval,keys:{encryption:process.env.ENCRYPTION_KEY,fingerprint:process.env.CONTROL_FINGERPRINT_KEY}}),{mode:0o600});
}
try{await seed();}finally{await pool.end();}
