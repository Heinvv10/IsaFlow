import {randomBytes,randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditComparison} from '@/modules/accounting/services/controls/auditComparisonJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {createIsolatedAuditJobRunner} from '@/modules/accounting/services/controls/auditJobProcess';
export async function comparisonDispatchFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config),entryPath=process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT;
 if(process.env.ISAFLOW_FORENSIC_PROCESS_TEST!=='1'||!entryPath||!isAbsolute(entryPath))throw new Error('Explicit local cold-process opt-in and artifact required');
 process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:4});
 try{
  const f=await provisionForensicFixture(config),runner=createIsolatedAuditJobRunner({nodePath:process.execPath,entryPath});
  const identity=(jobId:string=randomUUID())=>({companyId:f.companyA,personId:f.u1.id,jobId});
  const actor=<T>(fn:()=>Promise<T>)=>withAuditWorkerTransaction(pool,identity(),'read committed',Date.now()+15000,undefined,
   store=>withControlRequest(store,{companyId:f.companyA,personId:f.u1.id,authMethod:'cookie'},fn));
  async function snapshot(){
   const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
   const result=await runAuditSnapshotJob(identity(job.id),{pool});if(result.state!=='succeeded')throw new Error(`Synthetic snapshot creation failed: ${JSON.stringify(result)}`);return job.id;
  }
  const enqueue=(first:string,second=first)=>actor(()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()}));
  const original=async(id:string)=>({
   snapshot:(await pool.query('SELECT canonical_hash,protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0],
   artifacts:(await pool.query('SELECT artifact_id,protected_artifact FROM control_audit_snapshot_artifacts WHERE company_id=$1 AND snapshot_id=$2 ORDER BY artifact_id',[f.companyA,id])).rows,
  });
  async function removeCompanion(id:string,removeIndex=false){
   const tables=['control_audit_comparison_source_items','control_audit_comparison_sources',...(removeIndex?['control_audit_snapshot_index_chunks','control_audit_snapshot_index_items','control_audit_snapshot_indexes']:[])];
   for(const table of tables)await pool.query(`DELETE FROM ${table} WHERE company_id=$1 AND snapshot_id=$2`,[f.companyA,id]);
  }
  return{pool,f,identity,actor,snapshot,enqueue,original,removeCompanion,runner,close:()=>pool.end()};
 }catch(error){await pool.end();throw error;}
}
