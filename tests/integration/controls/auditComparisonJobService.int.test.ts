import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditComparison} from '@/modules/accounting/services/controls/auditComparisonJobService';
import {runAuditSnapshotJob,runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {openAuditJobRequest} from '@/modules/accounting/services/controls/auditJobProtection';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let f:ForensicFixture,first:string,second:string;
function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'|'u3'='u1'){
 const user=f[person];return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},fn));
}
beforeAll(async()=>{f=await provisionForensicFixture(config);
 const ids:string[]=[];
 for(const sources of [['journals','payroll'],['journals','bank']]){
  if(ids.length)await pool.query("INSERT INTO gl_journal_entries(company_id,entry_date,source,status,created_by) VALUES($1,'2026-09-09','manual','draft',$2)",[f.companyA,f.u1.id]);
  const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources,checks:[],idempotencyKey:randomUUID()}));ids.push(job.id);
  expect(await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded'});
 }
 [first,second]=ids as [string,string];
 // Foreground enqueue/status must use bounded authenticated metadata, never the complete original seal.
 await pool.query("UPDATE control_audit_snapshots SET protected_snapshot='{}' WHERE company_id=$1 AND id=ANY($2::uuid[])",[f.companyA,ids]);
});afterAll(()=>pool.end());
it('concurrent enqueue is metadata-only, ordered, requester-owned and idempotent with the exact union authority',async()=>{
 const request={firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()};
 const jobs=await Promise.all([actor(()=>enqueueAuditComparison(requireControlTx(),request)),actor(()=>enqueueAuditComparison(requireControlTx(),request))]);
 expect(jobs[0]).toEqual(jobs[1]);expect(jobs[0]).toMatchObject({kind:'audit_compare',state:'queued',attempts:0,resultComparisonId:null});
 const row=(await pool.query('SELECT * FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[f.companyA,jobs[0]!.id])).rows[0];
 expect(openAuditJobRequest(row)).toMatchObject({kind:'audit_compare',request:{...request,permissions:['read:bank-tx','read:payroll','read:reports'],comparisonRuleVersion:1}});
 await expect(actor(()=>enqueueAuditComparison(requireControlTx(),{...request,firstSnapshotId:second,secondSnapshotId:first}))).rejects.toThrow(/Idempotency/);
 await expect(actor(()=>getAuditJob(requireControlTx(),jobs[0]!.id),'u2')).rejects.toThrow(/not found/);
});
it('rechecks both source domains on retries and status and refuses foreign sources or supplied authority',async()=>{
 const request={firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()},job=await actor(()=>enqueueAuditComparison(requireControlTx(),request));
 for(const module of ['payroll','banking']){
  await pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[f.companyA,f.u1.id,module]);
  try{await expect(actor(()=>enqueueAuditComparison(requireControlTx(),request))).rejects.toThrow();await expect(actor(()=>getAuditJob(requireControlTx(),job.id))).rejects.toThrow();}
  finally{await pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.companyA,f.u1.id,module]);}
 }
 await expect(actor(()=>enqueueAuditComparison(requireControlTx(),request),'u3')).rejects.toThrow(/unavailable/);
 for(const extra of [{permissions:['read:reports']},{firstCanonicalHash:'a'.repeat(64)},{companyId:f.companyA}])await expect(actor(()=>enqueueAuditComparison(requireControlTx(),{...request,...extra}))).rejects.toThrow();
});
it('rolls back queued work with the request and never publishes a result during enqueue or status',async()=>{
 const request={firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()};
 await expect(actor(async()=>{await enqueueAuditComparison(requireControlTx(),request);throw new Error('Synthetic rollback');})).rejects.toThrow('Synthetic rollback');
 expect((await pool.query('SELECT id FROM control_audit_job_intents WHERE company_id=$1 AND idempotency_key=$2',[f.companyA,request.idempotencyKey])).rows).toEqual([]);
 const job=await actor(()=>enqueueAuditComparison(requireControlTx(),request));expect(await actor(()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({state:'queued',attempts:0});
 expect((await pool.query('SELECT job_id FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=$2',[f.companyA,job.id])).rows).toEqual([]);
});

it('executes the actual comparison worker and publishes complete authenticated change references with its deterministic hash',async()=>{
 const {openComparisonResultHeader,openComparisonResultItem}=await import('@/modules/accounting/services/controls/auditComparisonResultProtection');
 const {createComparisonResultDigest}=await import('@/modules/accounting/services/controls/auditComparisonResultDigest');
 const job=await actor(()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()}));
 const result=await runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool});expect(result).toMatchObject({state:'succeeded',comparisonId:job.id});
 const row=(await pool.query('SELECT generation,lease_id,protected_header FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=$2',[f.companyA,job.id])).rows[0];
 const header=openComparisonResultHeader(row.protected_header,{companyId:f.companyA,comparisonId:job.id,generation:Number(row.generation),leaseId:row.lease_id});
 const rows=(await pool.query('SELECT section,position,protected_item FROM control_audit_comparison_items WHERE company_id=$1 AND job_id=$2 ORDER BY section,position',[f.companyA,job.id])).rows;
 expect(rows).toHaveLength(1);const change=openComparisonResultItem(rows[0].protected_item,header,'records',0);
 expect(change).toMatchObject({kind:'added',section:'records',before:null,after:{snapshotId:second}});
 expect(header.counts.records).toEqual({first:0,second:1,added:1,removed:0,changed:0,unchanged:0});
 const digest=createComparisonResultDigest();digest.append(change);expect(digest.finish(header)).toBe(header.canonicalHash);
 expect(await actor(()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({kind:'audit_compare',state:'succeeded',resultComparisonId:job.id});
 expect(await runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toEqual({state:'not_claimed'});
});
it('converts a legacy companion in the worker without rewriting its original and supports self comparison',async()=>{
 const legacy=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 expect(await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:legacy.id},{pool})).toMatchObject({state:'succeeded'});
 const original=(await pool.query('SELECT canonical_hash,protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,legacy.id])).rows[0];
 await pool.query('DELETE FROM control_audit_comparison_source_items WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,legacy.id]);
 await pool.query('DELETE FROM control_audit_comparison_sources WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,legacy.id]);
 const job=await actor(()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:legacy.id,secondSnapshotId:legacy.id,idempotencyKey:randomUUID()}));
 expect((await pool.query('SELECT snapshot_id FROM control_audit_comparison_sources WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,legacy.id])).rows).toEqual([]);
 expect(await runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded',comparisonId:job.id});
 expect((await pool.query('SELECT build_job_id FROM control_audit_comparison_sources WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,legacy.id])).rows).toEqual([{build_job_id:job.id}]);
 expect((await pool.query('SELECT canonical_hash,protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,legacy.id])).rows[0]).toEqual(original);
 expect((await pool.query('SELECT position FROM control_audit_comparison_items WHERE company_id=$1 AND job_id=$2',[f.companyA,job.id])).rows).toEqual([]);
});
it('rolls back incomplete retained comparison output without a published result or success pointer',async()=>{
 const job=await actor(()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()}));
 await pool.query(`CREATE FUNCTION public.synthetic_comparison_result_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.companyA}'::uuid AND NEW.job_id='${job.id}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$`);
 try{await pool.query('CREATE TRIGGER synthetic_comparison_result_suppress BEFORE INSERT ON control_audit_comparison_items FOR EACH ROW EXECUTE FUNCTION public.synthetic_comparison_result_suppress()');
  expect(await runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'failed',failureRecorded:true});
  expect((await pool.query('SELECT state,result_comparison_id FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[f.companyA,job.id])).rows).toEqual([{state:'failed',result_comparison_id:null}]);
  for(const table of ['control_audit_comparison_items','control_audit_comparison_results'])expect((await pool.query(`SELECT job_id FROM ${table} WHERE company_id=$1 AND job_id=$2`,[f.companyA,job.id])).rows).toEqual([]);
 }finally{await pool.query('DROP TRIGGER IF EXISTS synthetic_comparison_result_suppress ON control_audit_comparison_items');await pool.query('DROP FUNCTION public.synthetic_comparison_result_suppress()');}
});
it('current source revocation after enqueue prevents worker publication',async()=>{
 const job=await actor(()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()}));
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'banking',false)",[f.companyA,f.u1.id]);
 try{expect(await runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'failed',code:'AUTHORITY_REVOKED'});
  expect((await pool.query('SELECT job_id FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=$2',[f.companyA,job.id])).rows).toEqual([]);
 }finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[f.companyA,f.u1.id]);}
});
it('independent jobs over the same retained sources produce exactly the same canonical result hash',async()=>{
 const hashes:string[]=[];
 for(let i=0;i<2;i++){
  const job=await actor(()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()}));
  const result=await runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool});expect(result.state).toBe('succeeded');
  if(result.state!=='succeeded')throw new Error('Comparison failed');hashes.push(result.canonicalHash);
 }
 expect(hashes[0]).toBe(hashes[1]);
});
