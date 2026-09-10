import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {storeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {executeHistoricalImport,type HistoricalImportEffect} from '@/modules/accounting/services/controls/historicalImportExecution';
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
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 for(const [code,type,subtype,normal] of [['CASE-D','asset','receivable','debit'],['CASE-C','revenue','default_revenue','credit']])
  await pool.query('INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level,is_system_account) VALUES($1,$2,$2,$3,$4,$5,true,3,true)',[fixture.companyA,code,type,subtype,normal]);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'Synthetic case replay',3,2023,'2023-03-01','2023-03-31','open')",[fixture.companyA]);
});
afterAll(async()=>{await pool.end();});
async function prepared():Promise<OperationRef>{
 const sourceKey=randomUUID();
 const body={version:1,sourceSystem:'csv',sourceKey,kind:'gl',mode:'post_journal',accountingDate:'2023-03-01',currency:'ZAR',records:[
  {recordId:'1',accountCode:'CASE-D',debit:'10',credit:'0',description:'Synthetic debit'},
  {recordId:'2',accountCode:'CASE-C',debit:'0',credit:'10',description:'Synthetic credit'}]};
 const source=await actor('u1',ctx=>storeHistoricalImportSource(ctx,{bytes:Buffer.from(JSON.stringify(body)),mimeType:'application/json'}));
 const saved=await actor('u1',ctx=>prepareHistoricalImport(ctx,{sourceSystem:'csv',sourceKey,kind:'gl',mode:'post_journal',accountingDate:'2023-03-01',evidenceId:source.sourceId,sourceRecordIds:['1','2']}));
 expect(saved.importId.toUpperCase()).not.toBe(saved.importId);
 return{entityType:'historical_import',entityId:saved.importId,operation:'historical_import.post'};
}
async function approved(ref:OperationRef){
 const approval=await actor('u1',ctx=>requestOperationApproval(ctx,ref));
 await actor('u2',ctx=>decideOperationApproval(ctx,approval.id,'approved'));
 return approval.id;
}
async function exactPopulation(id:string){
 const journals=await pool.query("SELECT id,entry_number,status FROM gl_journal_entries WHERE company_id=$1 AND source='auto_gl_import' AND source_record_id=$2::uuid ORDER BY entry_number",[fixture.companyA,id]);
 const totals=await pool.query("SELECT COALESCE(sum(l.debit),0)::text AS debit,COALESCE(sum(l.credit),0)::text AS credit FROM gl_journal_lines l JOIN gl_journal_entries j ON j.company_id=l.company_id AND j.id=l.journal_entry_id WHERE j.company_id=$1 AND j.source='auto_gl_import' AND j.source_record_id=$2::uuid AND j.status='posted'",[fixture.companyA,id]);
 const effects=await pool.query("SELECT id,entity_id,result FROM control_operation_effects WHERE company_id=$1 AND entity_type='historical_import' AND operation='historical_import.post' AND lower(entity_id)=$2",[fixture.companyA,id]);
 return{journals:journals.rows,totals:totals.rows[0],effects:effects.rows};
}
it('cannot post one persisted GL import twice through independently approved UUID case variants in an open period',async()=>{
 const ref=await prepared(),firstApproval=await approved(ref);
 const first=await actor('u1',ctx=>executeHistoricalImport(ctx,ref,firstApproval));
 const upper={...ref,entityId:ref.entityId.toUpperCase()},secondApproval=await approved(upper);
 let second:HistoricalImportEffect|undefined,refusal:unknown;
 try{second=await actor('u1',ctx=>executeHistoricalImport(ctx,upper,secondApproval));}catch(error){refusal=error;}
 const population=await exactPopulation(ref.entityId);
 expect(population.journals).toHaveLength(1);
 expect(population.effects).toHaveLength(1);
 expect(population.totals).toEqual({debit:'10.00',credit:'10.00'});
 expect(population.journals[0]).toMatchObject({id:first.journalEntryId,status:'posted'});
 if(second)expect(second).toEqual(first);else expect(refusal).toBeInstanceOf(Error);
});
it('returns the original receipt for uppercase UUID retries without another approval',async()=>{
 const ref=await prepared(),approval=await approved(ref);
 const first=await actor('u1',ctx=>executeHistoricalImport(ctx,ref,approval));
 await expect(actor('u1',ctx=>executeHistoricalImport(ctx,{...ref,entityId:ref.entityId.toUpperCase()}))).resolves.toEqual(first);
 expect((await exactPopulation(ref.entityId)).journals).toHaveLength(1);
});
