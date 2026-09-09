import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {stageSageHistoricalLedgerGroup} from '@/modules/accounting/services/core/sageHistoricalSourceService';
import {readHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {executeHistoricalImport} from '@/modules/accounting/services/controls/historicalImportExecution';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:10000});
let fixture:ForensicFixture;const debit=randomUUID(),credit=randomUUID(),mapping=randomUUID();
async function actor<T>(person:'u1'|'u2'|'u3',fn:(ctx:ControlTx)=>Promise<T>){const client=await pool.connect(),user=fixture[person];try{
 await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
 await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
 const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
 if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic request did not commit');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,level) VALUES($1,$3,'HS-D','Synthetic Sage debit','asset','debit',true,3),($2,$3,'HS-C','Synthetic Sage credit','revenue','credit',true,3)",[debit,credit,fixture.companyA]);
 await pool.query("INSERT INTO sage_accounts(id,company_id,account_code,account_name,gl_account_id,mapping_status) VALUES($1,$3,'S-D','Source debit',$4,'mapped'),($2,$3,'S-C','Source credit',$5,'mapped')",[mapping,randomUUID(),fixture.companyA,debit,credit]);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'Synthetic historical Sage',2,2023,'2023-02-01','2023-02-28','closed')",[fixture.companyA]);
});
afterAll(async()=>{await pool.end();});
async function group(){const reference=randomUUID(),ids=[randomUUID(),randomUUID()];
 await pool.query("INSERT INTO sage_ledger_transactions(id,company_id,sage_id,account_code,transaction_date,description,debit,credit,reference,migration_status) VALUES($1,$3,'D','S-D','2023-02-28','Persisted source debit',100.01,0,$4,'pending'),($2,$3,'C','S-C','2023-02-28','Persisted source credit',0,100.01,$4,'pending')",[...ids,fixture.companyA,reference]);
 return{reference,ids};}
async function staged(reference:string|null){return actor('u1',ctx=>stageSageHistoricalLedgerGroup(ctx,{accountingDate:'2023-02-28',reference}));}
async function approved(importId:string){const ref:OperationRef={entityType:'historical_import',entityId:importId,operation:'historical_import.post'};
 const approval=await actor('u1',ctx=>requestOperationApproval(ctx,ref));await actor('u2',ctx=>decideOperationApproval(ctx,approval.id,'approved'));return{ref,approvalId:approval.id};}
it('stages complete actual persisted Sage columns and posts only after independent approval',async()=>{
 const input=await group(),result=await staged(input.reference),source=await actor('u2',ctx=>readHistoricalImportSource(ctx,result.sourceId));
 expect(source.normalized.amount).toBe('100.01');expect(JSON.parse(source.bytes.toString()).rows.map((row:{id:string})=>row.id).sort()).toEqual(input.ids.sort());
 const {ref,approvalId}=await approved(result.importId);
 const effect=await actor('u1',ctx=>executeHistoricalImport(ctx,ref,approvalId));expect(effect.amount).toBe('100.01');
 expect(await actor('u1',ctx=>executeHistoricalImport(ctx,ref))).toEqual(effect);
 await expect(actor('u3',ctx=>readHistoricalImportSource(ctx,result.sourceId))).rejects.toThrow();
});
it('includes an unmapped line in the complete document and refuses before any financial writes',async()=>{
 const input=await group();await pool.query("UPDATE sage_ledger_transactions SET account_code='UNMAPPED' WHERE company_id=$1 AND id=$2",[fixture.companyA,input.ids[0]]);
 await expect(staged(input.reference)).rejects.toThrow('unmapped');
});
it('refuses changed persisted source amounts after approval',async()=>{
 const input=await group(),result=await staged(input.reference),approvedGroup=await approved(result.importId);
 await pool.query('UPDATE sage_ledger_transactions SET debit=101.01 WHERE company_id=$1 AND id=$2',[fixture.companyA,input.ids[0]]);
 await expect(actor('u1',ctx=>executeHistoricalImport(ctx,approvedGroup.ref,approvedGroup.approvalId))).rejects.toThrow('changed');
});
it('refuses a changed owned account mapping after approval',async()=>{
 const input=await group(),result=await staged(input.reference),approvedGroup=await approved(result.importId);
 try{await pool.query('UPDATE sage_accounts SET gl_account_id=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,mapping,credit]);
  await expect(actor('u1',ctx=>executeHistoricalImport(ctx,approvedGroup.ref,approvedGroup.approvalId))).rejects.toThrow('changed');
 }finally{await pool.query('UPDATE sage_accounts SET gl_account_id=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,mapping,debit]);}
});
it('refuses newly added source population after approval rather than posting an approved subset',async()=>{
 const input=await group(),result=await staged(input.reference),approvedGroup=await approved(result.importId);
 await pool.query("INSERT INTO sage_ledger_transactions(company_id,account_code,transaction_date,description,debit,credit,reference,migration_status) VALUES($1,'S-D','2023-02-28','Later source debit',1,0,$2,'pending'),($1,'S-C','2023-02-28','Later source credit',0,1,$2,'pending')",[fixture.companyA,input.reference]);
 await expect(actor('u1',ctx=>executeHistoricalImport(ctx,approvedGroup.ref,approvedGroup.approvalId))).rejects.toThrow('changed');
});
it('blocks concurrent source and mapping phantoms through actual company foreign-key locks',async()=>{
 const input=await group();await actor('u1',async ctx=>{
  await stageSageHistoricalLedgerGroup(ctx,{accountingDate:'2023-02-28',reference:input.reference});
  for(const table of ['source','mapping']){const other=await pool.connect();try{
   await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='250ms'");
   const insert=table==='source'?other.query("INSERT INTO sage_ledger_transactions(company_id,account_code,transaction_date,debit,credit,reference) VALUES($1,'S-D','2023-02-28',1,0,$2)",[fixture.companyA,input.reference])
    :other.query("INSERT INTO sage_accounts(company_id,account_code,account_name,gl_account_id) VALUES($1,'S-D','Concurrent duplicate mapping',$2)",[fixture.companyA,debit]);
   await expect(insert).rejects.toMatchObject({code:'55P03'});
  }finally{await other.query('ROLLBACK');other.release();}}
 });
});

it('keeps SQL null and empty reference source groups distinct at persisted preparation',async()=>{
 const a=await group(),b=await group();
 await pool.query('UPDATE sage_ledger_transactions SET reference=NULL WHERE company_id=$1 AND id=ANY($2::uuid[])',[fixture.companyA,a.ids]);
 await pool.query("UPDATE sage_ledger_transactions SET reference='' WHERE company_id=$1 AND id=ANY($2::uuid[])",[fixture.companyA,b.ids]);
 const nullGroup=await staged(null),emptyGroup=await staged('');expect(nullGroup.importId).not.toBe(emptyGroup.importId);
 for(const prepared of [nullGroup,emptyGroup]){const approval=await approved(prepared.importId);expect((await actor('u1',ctx=>executeHistoricalImport(ctx,approval.ref,approval.approvalId))).amount).toBe('100.01');}
});
it('refuses reuse of the same persisted source records after their reference changes following a successful import',async()=>{
 const input=await group(),prepared=await staged(input.reference),approval=await approved(prepared.importId);
 await actor('u1',ctx=>executeHistoricalImport(ctx,approval.ref,approval.approvalId));
 const changedReference=randomUUID();await pool.query('UPDATE sage_ledger_transactions SET reference=$3 WHERE company_id=$1 AND id=ANY($2::uuid[])',[fixture.companyA,input.ids,changedReference]);
 await expect((async()=>{const duplicate=await staged(changedReference),secondApproval=await approved(duplicate.importId);
  return actor('u1',ctx=>executeHistoricalImport(ctx,secondApproval.ref,secondApproval.approvalId));})()).rejects.toThrow('already');
});
it('serializes approved different-reference versions of the same source rows and blocks later reuse',async()=>{
 const input=await group(),a=await staged(input.reference),approvalA=await approved(a.importId),secondReference=randomUUID();
 await pool.query('UPDATE sage_ledger_transactions SET reference=$3 WHERE company_id=$1 AND id=ANY($2::uuid[])',[fixture.companyA,input.ids,secondReference]);
 const b=await staged(secondReference),approvalB=await approved(b.importId);
 const results=await Promise.allSettled([actor('u1',ctx=>executeHistoricalImport(ctx,approvalA.ref,approvalA.approvalId)),actor('u1',ctx=>executeHistoricalImport(ctx,approvalB.ref,approvalB.approvalId))]);
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results[1]?.status).toBe('fulfilled');
 await pool.query('UPDATE sage_ledger_transactions SET reference=$3 WHERE company_id=$1 AND id=ANY($2::uuid[])',[fixture.companyA,input.ids,input.reference]);
 await expect(actor('u1',ctx=>executeHistoricalImport(ctx,approvalA.ref,approvalA.approvalId))).rejects.toThrow('already');
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=ANY($2::uuid[])',[fixture.companyA,[a.importId,b.importId]])).rows).toHaveLength(1);
});
