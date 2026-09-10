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
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let f:ForensicFixture;
beforeAll(async()=>{f=await provisionForensicFixture(config);
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,source,status,created_by) SELECT id,$2,'2026-09-09','manual','draft',$3 FROM unnest($1::uuid[]) id",[Array.from({length:205},()=>randomUUID()),f.companyA,f.u1.id]);
});afterAll(()=>pool.end());
function actor<T>(person:'u1'|'u2',action:()=>Promise<T>){return withAuditWorkerTransaction(pool,{companyId:f.companyA,personId:f[person].id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:f.companyA,personId:f[person].id,authMethod:'cookie'},action));}
async function prepared(){
 const original=await actor('u1',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 expect(await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:original.id},{pool})).toMatchObject({state:'succeeded'});
 // Enqueue before synthetic removal deliberately exercises the immutable v1 pinned hash too.
 const comparison=await actor('u2',()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:original.id,secondSnapshotId:original.id,idempotencyKey:randomUUID()}));
 const lease=await actor('u2',()=>claimAuditJob(requireControlTx(),comparison.id));if(!lease)throw new Error('Missing comparison lease');
 const retained=(await pool.query('SELECT canonical_hash,protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,original.id])).rows[0];
 return{id:original.id,lease,retained};
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
 const {id,lease,retained}=await prepared();await removeIndex(id);
 const header=await convert(lease,id);expect(header.canonicalHash).toBe(retained.canonical_hash);expect(header.counts.records).toBe(205);
 const positions:number[]=[];let cursor:string|undefined;
 do{const page=await actor('u2',()=>getAuditSnapshotPage(requireControlTx(),{snapshotId:id,section:'records',limit:100,...cursor?{cursor}:{}}));positions.push(...page.items.map(item=>item.ordinal));cursor=page.nextCursor??undefined;}while(cursor);
 expect(positions).toEqual(Array.from({length:205},(_,i)=>i));
 const chunk=await actor('u2',()=>readAuditSnapshotChunk(requireControlTx(),{snapshotId:id,section:'records',ordinal:0,chunkOrdinal:0}));
 expect(JSON.parse(Buffer.from(chunk.bytes).toString())).toMatchObject({source:'journal_entry'});
 expect((await pool.query('SELECT canonical_hash,protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0]).toEqual(retained);
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
 await pool.query("DELETE FROM control_audit_snapshot_index_items WHERE company_id=$1 AND snapshot_id=$2 AND section='records' AND ordinal=0",[f.companyA,id]);
 await expect(convert(lease,id)).rejects.toThrow(/incomplete|population|census/i);
 expect((await pool.query("SELECT ordinal FROM control_audit_snapshot_index_items WHERE company_id=$1 AND snapshot_id=$2 AND section='records' AND ordinal=0",[f.companyA,id])).rows).toEqual([]);
});
it('rejects a different original identity before attempting conversion',async()=>{
 const {lease}=await prepared();await expect(convert(lease,randomUUID())).rejects.toThrow(/source|request/i);
});
