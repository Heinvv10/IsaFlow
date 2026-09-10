import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditExport} from '@/modules/accounting/services/controls/auditExportJobService';
import {runAuditJob,runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {createAuditJobPoller} from '@/modules/accounting/services/controls/auditJobPoller';
import {getAuditExportFiles,readAuditExportChunk} from '@/modules/accounting/services/controls/auditExportReadService';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let fixture:ForensicFixture,snapshotId:string;
function actor<T>(fn:()=>Promise<T>){return withAuditWorkerTransaction(pool,{companyId:fixture.companyA,personId:fixture.u1.id,jobId:randomUUID()},'read committed',Date.now()+10000,undefined,
 store=>withControlRequest(store,{companyId:fixture.companyA,personId:fixture.u1.id,authMethod:'cookie'},fn));}
const identity=(jobId:string)=>({companyId:fixture.companyA,personId:fixture.u1.id,jobId});
const enqueue=()=>actor(()=>enqueueAuditExport(requireControlTx(),{snapshotId,idempotencyKey:randomUUID()}));
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','payroll'],checks:[],idempotencyKey:randomUUID()}));
 snapshotId=job.id;expect(await runAuditSnapshotJob(identity(job.id),{pool})).toMatchObject({state:'succeeded'});
});
afterAll(()=>pool.end());
it('executes a real queued export and reconstructs every authenticated file without duplicate retry publication',async()=>{
 const job=await enqueue();
 expect(await runAuditJob(identity(job.id),{pool,workerClass:'audit'})).toMatchObject({state:'succeeded',exportId:job.id});
 expect(await actor(()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({kind:'audit_export',state:'succeeded',resultExportId:job.id,attempts:1});
 const page=await actor(()=>getAuditExportFiles(requireControlTx(),{jobId:job.id}));expect(page.fileCount).toBe(6);expect(page.nextCursor).toBeNull();
 const contents=new Map<string,Buffer>();
 for(const file of page.files){const parts:Uint8Array[]=[];for(let n=0;n<file.chunkCount;n++)parts.push((await actor(()=>readAuditExportChunk(requireControlTx(),{jobId:job.id,fileOrdinal:file.ordinal,chunkOrdinal:n}))).bytes);
  const bytes=Buffer.concat(parts);expect(bytes.length).toBe(file.byteLength);expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);contents.set(file.path,bytes);}
 expect(JSON.parse(contents.get('snapshot.json')!.toString()).snapshotId).toBe(snapshotId);
 expect(contents.has('manifest.json')).toBe(true);
 expect(await runAuditJob(identity(job.id),{pool,workerClass:'audit'})).toEqual({state:'not_claimed'});
 expect((await pool.query('SELECT generation FROM control_audit_export_results WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows).toEqual([{generation:'1'}]);
});
it('refuses changed retained evidence and publishes no partial output',async()=>{
 const job=await enqueue();
 const original=(await pool.query('SELECT protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,snapshotId])).rows[0].protected_snapshot;
 await pool.query("UPDATE control_audit_snapshots SET protected_snapshot='{}' WHERE company_id=$1 AND id=$2",[fixture.companyA,snapshotId]);
 try{expect(await runAuditJob(identity(job.id),{pool,workerClass:'audit'})).toMatchObject({state:'failed',failureRecorded:true});}
 finally{await pool.query('UPDATE control_audit_snapshots SET protected_snapshot=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,snapshotId,original]);}
 expect((await pool.query('SELECT job_id FROM control_audit_export_files WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows).toEqual([]);
 await expect(actor(()=>getAuditExportFiles(requireControlTx(),{jobId:job.id}))).rejects.toThrow();
});
it('rechecks revoked source authority before claiming or rendering',async()=>{
 const job=await enqueue();
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[fixture.companyA,fixture.u1.id]);
 try{expect(await runAuditJob(identity(job.id),{pool,workerClass:'audit'})).toMatchObject({state:'failed',code:'AUTHORITY_REVOKED'});}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
 expect((await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0]).toEqual({state:'queued',attempts:0});
});
it('rolls back staged files and header when chunk storage fails',async()=>{
 const job=await actor(()=>enqueueAuditExport(requireControlTx(),{snapshotId,idempotencyKey:'synthetic-chunk-failure'}));
 await pool.query("CREATE OR REPLACE FUNCTION public.forensic_export_chunk_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM control_audit_job_intents i WHERE i.company_id=NEW.company_id AND i.id=NEW.job_id AND i.idempotency_key='synthetic-chunk-failure') THEN RAISE EXCEPTION 'Synthetic export chunk failure'; END IF; RETURN NEW; END $$");
 await pool.query('CREATE TRIGGER forensic_export_chunk_failure BEFORE INSERT ON control_audit_export_chunks FOR EACH ROW EXECUTE FUNCTION public.forensic_export_chunk_failure()');
 try{expect(await runAuditJob(identity(job.id),{pool,workerClass:'audit'})).toMatchObject({state:'failed',failureRecorded:true});}
 finally{await pool.query('DROP TRIGGER forensic_export_chunk_failure ON control_audit_export_chunks');await pool.query('DROP FUNCTION public.forensic_export_chunk_failure()');}
 expect((await pool.query('SELECT job_id FROM control_audit_export_files WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows).toEqual([]);
 expect((await pool.query('SELECT job_id FROM control_audit_export_results WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows).toEqual([]);
 expect(await actor(()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({state:'failed',resultExportId:null});
});
it('dispatches a queued export through the actual server poller',async()=>{
 const job=await enqueue(),poller=createAuditJobPoller({companyIds:[fixture.companyA],batchSize:10},{pool,executeJob:(identity,options)=>runAuditJob(identity,{pool,...options,workerClass:'audit'})});
 await poller.pollOnce();
 expect(await actor(()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({state:'succeeded',resultExportId:job.id});
});
