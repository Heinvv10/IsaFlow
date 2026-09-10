import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {readAuditSnapshotIntentMetadata} from '@/modules/accounting/services/controls/auditSnapshotIntentMetadata';
import {openProtectedChange,protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import {auditRequestHash} from '@/modules/accounting/services/controls/auditJobProtection';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let f:ForensicFixture,snapshotId:string;
const request={cutoff:'2026-09-09',sources:['journals','payroll','bank'],checks:[],idempotencyKey:randomUUID()};
function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'|'u3'='u2'){
 const user=f[person];return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},fn));
}
async function absentIndexes(){
 for(const table of ['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks','control_audit_comparison_sources','control_audit_comparison_source_items']){
  expect((await pool.query(`SELECT snapshot_id FROM ${table} WHERE company_id=$1 AND snapshot_id=$2`,[f.companyA,snapshotId])).rows).toEqual([]);
 }
}
beforeAll(async()=>{
 f=await provisionForensicFixture(config);const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),request),'u1');snapshotId=job.id;
 expect(await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded'});
 // Synthetic historical state: preserve genuine original seal/artifacts/intent; remove only derived indexes.
 for(const table of ['control_audit_snapshot_index_chunks','control_audit_snapshot_index_items','control_audit_snapshot_indexes','control_audit_comparison_source_items','control_audit_comparison_sources'])await pool.query(`DELETE FROM ${table} WHERE company_id=$1 AND snapshot_id=$2`,[f.companyA,snapshotId]);
});afterAll(()=>pool.end());
it('reads authenticated original request anchors for a genuine indexless snapshot as another current reader without conversion',async()=>{
 const before=(await pool.query('SELECT protected_snapshot,canonical_hash FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId])).rows;
 const metadata=await actor(()=>readAuditSnapshotIntentMetadata(requireControlTx(),snapshotId));
 expect(metadata).toEqual({snapshotId,sourceJobId:snapshotId,sourceRequestHash:auditRequestHash({...request,sources:['bank','journals','payroll']}),permissions:['read:bank-tx','read:payroll','read:reports']});
 await absentIndexes();expect((await pool.query('SELECT protected_snapshot,canonical_hash FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId])).rows).toEqual(before);
 expect((await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[f.companyA,snapshotId])).rows).toEqual([{state:'succeeded',attempts:1}]);
});
it('requires current original request domains and refuses foreign or unissued callers',async()=>{
 await expect(actor(()=>readAuditSnapshotIntentMetadata(requireControlTx(),snapshotId),'u3')).rejects.toThrow(/unavailable/);
 for(const module of ['banking','payroll']){
  await pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[f.companyA,f.u2.id,module]);
  try{await expect(actor(()=>readAuditSnapshotIntentMetadata(requireControlTx(),snapshotId))).rejects.toThrow();}
  finally{await pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.companyA,f.u2.id,module]);}
 }
 await expect(readAuditSnapshotIntentMetadata({} as ReturnType<typeof requireControlTx>,snapshotId)).rejects.toThrow();await absentIndexes();
});
it('refuses an unavailable succeeded pointer and wrong original kind without rebuilding anything',async()=>{
 await pool.query("UPDATE control_audit_jobs SET state='failed',result_snapshot_id=NULL WHERE company_id=$1 AND job_id=$2",[f.companyA,snapshotId]);
 try{await expect(actor(()=>readAuditSnapshotIntentMetadata(requireControlTx(),snapshotId))).rejects.toThrow(/unavailable/);}
 finally{await pool.query("UPDATE control_audit_jobs SET state='succeeded',result_snapshot_id=$2 WHERE company_id=$1 AND job_id=$2",[f.companyA,snapshotId]);}
 await pool.query("UPDATE control_audit_job_intents SET kind='audit_export' WHERE company_id=$1 AND id=$2",[f.companyA,snapshotId]);
 try{await expect(actor(()=>readAuditSnapshotIntentMetadata(requireControlTx(),snapshotId))).rejects.toThrow(/identity/);}
 finally{await pool.query("UPDATE control_audit_job_intents SET kind='audit_snapshot' WHERE company_id=$1 AND id=$2",[f.companyA,snapshotId]);}
 await absentIndexes();
});
it('refuses tampered and SQL-byte-oversized original intents',async()=>{
 const original=(await pool.query('SELECT protected_request FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId])).rows[0];
 for(const tampered of [{}, {version:1,keyId:'current',ciphertext:'x'.repeat(65536)}]){
  await pool.query('UPDATE control_audit_job_intents SET protected_request=$3 WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId,tampered]);
  try{const promise=actor(()=>readAuditSnapshotIntentMetadata(requireControlTx(),snapshotId));if('ciphertext'in tampered)await expect(promise).rejects.toThrow(/byte limit/);else await expect(promise).rejects.toThrow();}
  finally{await pool.query('UPDATE control_audit_job_intents SET protected_request=$3 WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId,original.protected_request]);}
 }
 await absentIndexes();
});
it('allows current retained reading after original delegation expiry without claiming verification of original contents',async()=>{
 const original=(await pool.query('SELECT protected_request FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId])).rows[0];
 const body=openProtectedChange(original.protected_request).after;if(!body)throw new Error('Expected genuine saved intent');
 const expired=protectChangeValues('audit_job',null,{...body,delegationExpiresAt:'2020-01-01T00:00:00.000Z'}).protectedPayload;
 await pool.query('UPDATE control_audit_job_intents SET protected_request=$3 WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId,expired]);
 const snapshot=(await pool.query('SELECT protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId])).rows[0];
 try{await pool.query("UPDATE control_audit_snapshots SET protected_snapshot='{}' WHERE company_id=$1 AND id=$2",[f.companyA,snapshotId]);
  const result=await actor(()=>readAuditSnapshotIntentMetadata(requireControlTx(),snapshotId));expect(result.sourceJobId).toBe(snapshotId);expect(result).not.toHaveProperty('canonicalHash');await absentIndexes();
 }finally{await pool.query('UPDATE control_audit_snapshots SET protected_snapshot=$3 WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId,snapshot.protected_snapshot]);await pool.query('UPDATE control_audit_job_intents SET protected_request=$3 WHERE company_id=$1 AND id=$2',[f.companyA,snapshotId,original.protected_request]);}
});
