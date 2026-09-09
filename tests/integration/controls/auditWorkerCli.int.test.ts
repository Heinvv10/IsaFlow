import {beforeAll,afterAll,expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget,provisionForensicFixture,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditExport} from '@/modules/accounting/services/controls/auditExportJobService';
import {getAuditExportFiles,readAuditExportChunk} from '@/modules/accounting/services/controls/auditExportReadService';
const exec=promisify(execFile),target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
let fixture:ForensicFixture;
beforeAll(async()=>{
 if(process.env.ISAFLOW_FORENSIC_PROCESS_TEST!=='1'||!process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT)throw new Error('Explicit process fixture artifact required');
 fixture=await provisionForensicFixture(fixtureConfigFromEnv(process.env));
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
});
afterAll(()=>pool.end());
async function actor<T>(person:'u1'|'u3',work:()=>Promise<T>){const user=fixture[person];
 return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+10000,undefined,
  store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},work));
}
const enqueue=(person:'u1'|'u3')=>actor(person,()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
async function cli(){
 const result=await exec('bun',['scripts/forensic/run-audit-worker.ts','--company',fixture.companyA,'--once'],{
  cwd:resolve('.'),timeout:20000,maxBuffer:32768,env:{...process.env,DATABASE_SSL:'disable',ISAFLOW_AUDIT_WORKER_DATABASE_URL:target.connectionString,
   ISAFLOW_AUDIT_WORKER_NODE_PATH:process.execPath,ISAFLOW_AUDIT_WORKER_ENTRY_PATH:process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT}});
 return result.stdout;
}
it('production CLI publishes an isolated snapshot then export with complete authenticated file bytes',async()=>{
 const job=await enqueue('u1'),foreign=await enqueue('u3');
 expect(await cli()).toContain('Audit isolated worker observed');
 expect(await actor('u1',()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({state:'succeeded',attempts:1});
 expect(await actor('u3',()=>getAuditJob(requireControlTx(),foreign.id))).toMatchObject({state:'queued',attempts:0});
 const exportJob=await actor('u1',()=>enqueueAuditExport(requireControlTx(),{snapshotId:job.id,idempotencyKey:randomUUID()}));
 expect(await cli()).toContain('Audit isolated worker observed');
 expect(await actor('u1',()=>getAuditJob(requireControlTx(),exportJob.id))).toMatchObject({state:'succeeded',attempts:1});
 let cursor:string|undefined,files=0;
 do{
  const page=await actor('u1',()=>getAuditExportFiles(requireControlTx(),{jobId:exportJob.id,limit:2,...(cursor?{cursor}:{})}));
  for(const file of page.files){const hash=createHash('sha256');let size=0;
   for(let chunkOrdinal=0;chunkOrdinal<file.chunkCount;chunkOrdinal++){
    const chunk=await actor('u1',()=>readAuditExportChunk(requireControlTx(),{jobId:exportJob.id,fileOrdinal:file.ordinal,chunkOrdinal}));
    hash.update(chunk.bytes);size+=chunk.bytes.length;
   }
   expect(size).toBe(file.byteLength);expect(hash.digest('hex')).toBe(file.sha256);files++;
  }
  cursor=page.nextCursor??undefined;if(!cursor)expect(files).toBe(page.fileCount);
 }while(cursor);
 expect(files).toBeGreaterThan(2);expect(await cli()).not.toContain('Audit isolated worker observed');
});
it('concurrent production pollers claim one saved job at most once',async()=>{
 const job=await enqueue('u1');await Promise.all([cli(),cli()]);
 expect(await actor('u1',()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({state:'succeeded',attempts:1});
 expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,job.id])).rows).toHaveLength(1);
});
