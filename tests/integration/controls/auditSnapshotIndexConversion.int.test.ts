import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditComparison} from '@/modules/accounting/services/controls/auditComparisonJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {claimAuditJob,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {getAuditSnapshotPage,readAuditSnapshotChunk} from '@/modules/accounting/services/controls/auditSnapshotPageService';
import {openProtectedChange,protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import {auditRequestHash} from '@/modules/accounting/services/controls/auditJobProtection';
import {evidenceScaleStorage} from './auditEvidenceScaleFixture';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let f:ForensicFixture,storage:Awaited<ReturnType<typeof evidenceScaleStorage>>;
beforeAll(async()=>{f=await provisionForensicFixture(config);storage=await evidenceScaleStorage();await storage.seed(pool,f.companyA,32,65);
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,source,status,created_by) SELECT id,$2,'2026-09-09','manual','draft',$3 FROM unnest($1::uuid[]) id",[Array.from({length:205},()=>randomUUID()),f.companyA,f.u1.id]);
});afterAll(async()=>{await storage?.close();await pool.end();});
function actor<T>(person:'u1'|'u2',action:()=>Promise<T>){return withAuditWorkerTransaction(pool,{companyId:f.companyA,personId:f[person].id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:f.companyA,personId:f[person].id,authMethod:'cookie'},action));}
async function prepared(uppercase=false){
 const original=await actor('u1',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','bank'],checks:[],idempotencyKey:randomUUID()}));
 expect(await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:original.id},{pool})).toMatchObject({state:'succeeded'});
 // Enqueue before synthetic removal deliberately exercises the immutable v1 pinned hash too.
 const comparison=await actor('u2',()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:original.id,secondSnapshotId:original.id,idempotencyKey:randomUUID()}));
 const lease=await actor('u2',()=>claimAuditJob(requireControlTx(),comparison.id));if(!lease)throw new Error('Missing comparison lease');
 if(uppercase){
  // Local compatibility fixture: authenticate a valid legacy v1 representation after claiming its real job.
  const row=(await pool.query('SELECT protected_request FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[f.companyA,comparison.id])).rows[0];
  const body=openProtectedChange(row.protected_request).after!;
  const request={...(body.request as Record<string,unknown>),firstSnapshotId:original.id.toUpperCase(),secondSnapshotId:original.id.toUpperCase()};
  const protectedRequest=protectChangeValues('audit_job',null,{...body,request}).protectedPayload;
  await pool.query('UPDATE control_audit_job_intents SET request_hash=$3,protected_request=$4::jsonb WHERE company_id=$1 AND id=$2',[f.companyA,comparison.id,auditRequestHash(request),JSON.stringify(protectedRequest)]);
 }
 const retained=(await pool.query('SELECT canonical_hash,protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,original.id])).rows[0];
 const artifacts=(await pool.query('SELECT artifact_id,protected_artifact FROM control_audit_snapshot_artifacts WHERE company_id=$1 AND snapshot_id=$2 ORDER BY artifact_id',[f.companyA,original.id])).rows;
 return{id:original.id,lease,retained,artifacts};
}
async function removeIndex(id:string){
 await pool.query('DELETE FROM control_audit_snapshot_index_chunks WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,id]);
 await pool.query('DELETE FROM control_audit_snapshot_index_items WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,id]);
 await pool.query('DELETE FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,id]);
}
async function convert(lease:AuditJobLease,id:string){
 const {ensureOriginalSnapshotIndex}=await import('@/modules/accounting/services/controls/auditSnapshotIndexConversion');
 return withAuditWorkerTransaction(pool,{companyId:f.companyA,personId:f.u2.id,jobId:lease.jobId},'repeatable read',Date.now()+15000,undefined,
 store=>withControlJobRequest(store,lease,()=>ensureOriginalSnapshotIndex(requireControlTx(),lease,id)));
}
it('converts a genuine original for a second authorized requester and preserves every original protected byte',async()=>{
 const {id,lease,retained,artifacts}=await prepared();await removeIndex(id);
 const header=await convert(lease,id);expect(header.canonicalHash).toBe(retained.canonical_hash);expect(header.counts.records).toBe(206);
 const positions:number[]=[];let cursor:string|undefined;
 do{const page=await actor('u2',()=>getAuditSnapshotPage(requireControlTx(),{snapshotId:id,section:'records',limit:100,...cursor?{cursor}:{}}));positions.push(...page.items.map(item=>item.ordinal));cursor=page.nextCursor??undefined;}while(cursor);
 expect(positions).toEqual(Array.from({length:206},(_,i)=>i));
 const chunk=await actor('u2',()=>readAuditSnapshotChunk(requireControlTx(),{snapshotId:id,section:'records',ordinal:0,chunkOrdinal:0}));
 expect(['journal_entry','bank_transaction']).toContain(JSON.parse(Buffer.from(chunk.bytes).toString()).source);
 expect((await pool.query('SELECT canonical_hash,protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0]).toEqual(retained);
 expect((await pool.query('SELECT artifact_id,protected_artifact FROM control_audit_snapshot_artifacts WHERE company_id=$1 AND snapshot_id=$2 ORDER BY artifact_id',[f.companyA,id])).rows).toEqual(artifacts);
 expect((await pool.query('SELECT build_job_id,build_generation,build_lease_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,id])).rows).toEqual([{build_job_id:lease.jobId,build_generation:String(lease.generation),build_lease_id:lease.leaseId}]);
});
it('refuses corrupt originals without publishing a replacement index',async()=>{
 const {id,lease}=await prepared();await removeIndex(id);
 await pool.query("UPDATE control_audit_snapshots SET protected_snapshot='{}'::jsonb WHERE company_id=$1 AND id=$2",[f.companyA,id]);
 await expect(convert(lease,id)).rejects.toThrow();
 expect((await pool.query('SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,id])).rows).toEqual([]);
});
it('refuses an incomplete existing index instead of silently rebuilding it',async()=>{
 const {id,lease}=await prepared();
 await pool.query("DELETE FROM control_audit_snapshot_index_chunks WHERE company_id=$1 AND snapshot_id=$2 AND section='records' AND ordinal=0",[f.companyA,id]);
 await pool.query("DELETE FROM control_audit_snapshot_index_items WHERE company_id=$1 AND snapshot_id=$2 AND section='records' AND ordinal=0",[f.companyA,id]);
 await expect(convert(lease,id)).rejects.toThrow(/incomplete|population|census/i);
 expect((await pool.query("SELECT ordinal FROM control_audit_snapshot_index_items WHERE company_id=$1 AND snapshot_id=$2 AND section='records' AND ordinal=0",[f.companyA,id])).rows).toEqual([]);
});
it('rejects a different original identity before attempting conversion',async()=>{
 const {lease}=await prepared();await expect(convert(lease,randomUUID())).rejects.toThrow(/source|request/i);
});

for(const damage of ['missing','corrupt'] as const)it(`refuses ${damage} retained evidence and rolls back every new index row`,async()=>{
 const {id,lease}=await prepared();await removeIndex(id);
 const artifacts=(await pool.query('SELECT artifact_id,protected_artifact FROM control_audit_snapshot_artifacts WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,id])).rows;
 expect(artifacts).toHaveLength(1);
 if(damage==='missing')await pool.query('DELETE FROM control_audit_snapshot_artifacts WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,id]);
 else await pool.query("UPDATE control_audit_snapshot_artifacts SET protected_artifact='{}'::jsonb WHERE company_id=$1 AND snapshot_id=$2",[f.companyA,id]);
 await expect(convert(lease,id)).rejects.toThrow();
 for(const table of ['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks']){
  expect((await pool.query(`SELECT snapshot_id FROM ${table} WHERE company_id=$1 AND snapshot_id=$2`,[f.companyA,id])).rows).toEqual([]);
 }
});
it('refuses incomplete chunks in an existing authenticated original index',async()=>{
 const {id,lease}=await prepared();
 await pool.query("DELETE FROM control_audit_snapshot_index_chunks WHERE company_id=$1 AND snapshot_id=$2 AND section='records' AND ordinal=0 AND chunk_ordinal=0",[f.companyA,id]);
 await expect(convert(lease,id)).rejects.toThrow(/incomplete|population|census/i);
});
it('reuses an existing complete index without rewriting its protected header',async()=>{
 const {id,lease}=await prepared();
 const before=(await pool.query('SELECT protected_header FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,id])).rows;
 const header=await convert(lease,id);expect(header.snapshotId).toBe(id);
 expect((await pool.query('SELECT protected_header FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,id])).rows).toEqual(before);
});

it('preserves legacy pinned hashes for mixed-case UUID representations of the same source',async()=>{
 const {id,lease,retained}=await prepared(true);await removeIndex(id);
 expect(await convert(lease,id)).toMatchObject({snapshotId:id,canonicalHash:retained.canonical_hash});
});
