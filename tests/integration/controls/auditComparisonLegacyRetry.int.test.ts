import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditComparison} from '@/modules/accounting/services/controls/auditComparisonJobService';
import {runAuditSnapshotJob,runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {openProtectedChange,protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import {auditRequestHash,openAuditJobRequest} from '@/modules/accounting/services/controls/auditJobProtection';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let f:ForensicFixture,first:string,second:string;
function actor<T>(action:()=>Promise<T>){return withAuditWorkerTransaction(pool,{companyId:f.companyA,personId:f.u1.id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:f.companyA,personId:f.u1.id,authMethod:'cookie'},action));}
async function snapshot(){
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','bank'],checks:[],idempotencyKey:randomUUID()}));
 expect(await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded'});return job.id;
}
beforeAll(async()=>{f=await provisionForensicFixture(config);first=await snapshot();second=await snapshot();});
afterAll(()=>pool.end());
async function intent(id:string){return (await pool.query('SELECT * FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0];}
async function legacy(uppercase=false,wrongHash=false){
 const request={firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()};
 const job=await actor(()=>enqueueAuditComparison(requireControlTx(),request)),row=await intent(job.id);
 const body=openProtectedChange(row.protected_request).after!;
 const hashes=(await pool.query('SELECT id,canonical_hash FROM control_audit_snapshots WHERE company_id=$1 AND id=ANY($2::uuid[])',[f.companyA,[first,second]])).rows;
 const saved={...request,firstSnapshotId:uppercase?first.toUpperCase():first,secondSnapshotId:uppercase?second.toUpperCase():second,
  firstCanonicalHash:wrongHash?'0'.repeat(64):hashes.find(r=>r.id===first)!.canonical_hash,secondCanonicalHash:hashes.find(r=>r.id===second)!.canonical_hash,
  permissions:['read:bank-tx','read:reports'],comparisonRuleVersion:1};
 // Synthetic migration compatibility fixture only: retain a cryptographically authenticated historical v1 intent.
 await pool.query('UPDATE control_audit_job_intents SET request_hash=$3,protected_request=$4::jsonb WHERE company_id=$1 AND id=$2',
  [f.companyA,job.id,auditRequestHash(saved),JSON.stringify(protectChangeValues('audit_job',null,{...body,request:saved}).protectedPayload)]);
 const original=await intent(job.id);expect(openAuditJobRequest(original)).toMatchObject({kind:'audit_compare',request:saved});
 return{job,request,original};
}
for(const uppercase of [false,true])it(`preserves authenticated v1 intent and returns its same job on current v2 retry (uppercase=${uppercase})`,async()=>{
 const {job,request,original}=await legacy(uppercase);
 expect(await actor(()=>enqueueAuditComparison(requireControlTx(),request))).toMatchObject({id:job.id,state:'queued',attempts:0});
 expect(await intent(job.id)).toEqual(original);
 expect(await runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded',comparisonId:job.id});
 expect(await actor(()=>enqueueAuditComparison(requireControlTx(),request))).toMatchObject({id:job.id,state:'succeeded'});
 expect(await intent(job.id)).toEqual(original);
});
it('rejects a changed ordered source pair and caller supplied authority on a saved v1 retry',async()=>{
 const {job,request,original}=await legacy();
 await expect(actor(()=>enqueueAuditComparison(requireControlTx(),{...request,firstSnapshotId:second,secondSnapshotId:first}))).rejects.toThrow(/Idempotency/);
 await expect(actor(()=>enqueueAuditComparison(requireControlTx(),{...request,permissions:['read:reports']}))).rejects.toThrow();
 expect(await intent(job.id)).toEqual(original);
});
it('rechecks current domain rights before returning a saved v1 retry',async()=>{
 const {job,request,original}=await legacy();
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'banking',false)",[f.companyA,f.u1.id]);
 try{await expect(actor(()=>enqueueAuditComparison(requireControlTx(),request))).rejects.toThrow();expect(await intent(job.id)).toEqual(original);}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[f.companyA,f.u1.id]);}
});
it('refuses an authenticated v1 hash mismatch rather than silently replacing its pinned request',async()=>{
 const {job,request,original}=await legacy(false,true);
 await expect(actor(()=>enqueueAuditComparison(requireControlTx(),request))).rejects.toThrow();expect(await intent(job.id)).toEqual(original);
});
it('rolls back the already inserted first original index when the second retained seal is corrupt',async()=>{
 const ids=[await snapshot(),await snapshot()].sort(),[good,bad]=ids as [string,string];
 for(const table of ['control_audit_comparison_source_items','control_audit_comparison_sources','control_audit_snapshot_index_chunks','control_audit_snapshot_index_items','control_audit_snapshot_indexes']){
  await pool.query(`DELETE FROM ${table} WHERE company_id=$1 AND snapshot_id=ANY($2::uuid[])`,[f.companyA,ids]);
 }
 await pool.query("UPDATE control_audit_snapshots SET protected_snapshot='{}'::jsonb WHERE company_id=$1 AND id=$2",[f.companyA,bad]);
 const originals=(await pool.query('SELECT * FROM control_audit_snapshots WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[f.companyA,ids])).rows;
 const job=await actor(()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:good,secondSnapshotId:bad,idempotencyKey:randomUUID()}));
 // A sequence is intentionally nontransactional: its increment witnesses the first INSERT even after rollback.
 const witness='legacy_rollback_'+randomUUID().replaceAll('-','');
 await pool.query(`CREATE SEQUENCE public.${witness}`);
 await pool.query(`GRANT USAGE ON SEQUENCE public.${witness} TO app_user`);
 try{
  await pool.query(`CREATE FUNCTION public.${witness}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.companyA}'::uuid AND NEW.snapshot_id='${good}'::uuid THEN PERFORM nextval('public.${witness}'); END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${witness} AFTER INSERT ON control_audit_snapshot_indexes FOR EACH ROW EXECUTE FUNCTION public.${witness}()`);
  expect(await runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'failed',failureRecorded:true});
  expect((await pool.query(`SELECT is_called FROM public.${witness}`)).rows).toEqual([{is_called:true}]);
  for(const table of ['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks','control_audit_comparison_sources','control_audit_comparison_source_items']){
   expect((await pool.query(`SELECT snapshot_id FROM ${table} WHERE company_id=$1 AND snapshot_id=ANY($2::uuid[])`,[f.companyA,ids])).rows).toEqual([]);
  }
  for(const table of ['control_audit_comparison_results','control_audit_comparison_items'])expect((await pool.query(`SELECT job_id FROM ${table} WHERE company_id=$1 AND job_id=$2`,[f.companyA,job.id])).rows).toEqual([]);
  expect((await pool.query('SELECT state,result_comparison_id FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[f.companyA,job.id])).rows).toEqual([{state:'failed',result_comparison_id:null}]);
  expect((await pool.query('SELECT * FROM control_audit_snapshots WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[f.companyA,ids])).rows).toEqual(originals);
 }finally{
  await pool.query(`DROP TRIGGER IF EXISTS ${witness} ON control_audit_snapshot_indexes`);
  await pool.query(`DROP FUNCTION IF EXISTS public.${witness}()`);await pool.query(`DROP SEQUENCE public.${witness}`);
 }
});
