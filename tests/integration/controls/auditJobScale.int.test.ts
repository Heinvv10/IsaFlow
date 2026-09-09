import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,open,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {seedAuditScale,readScaleCensus,scaleCensus,type ScaleCensus} from './auditJobScaleFixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditExport} from '@/modules/accounting/services/controls/auditExportJobService';
import {createIsolatedAuditJobRunner} from '@/modules/accounting/services/controls/auditJobProcess';
import {readAuditSnapshotIndexHeader} from '@/modules/accounting/services/controls/auditSnapshotIndexRead';
import {getAuditExportFiles,readAuditExportChunk} from '@/modules/accounting/services/controls/auditExportReadService';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import type {AuditSnapshotData} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import type {AuthenticatedExportManifest,ExportManifest} from '@/modules/accounting/services/controls/auditEvidenceExportMaterial';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const records=Number(process.env.ISAFLOW_AUDIT_SCALE_RECORDS??1000);
let pool:Pool,fixture:Pick<ForensicFixture,'companyA'>&{u1:{id:string}},census:ScaleCensus,directory:string;
const identity=(jobId:string)=>({companyId:fixture.companyA,personId:fixture.u1.id,jobId});
async function actor<T>(work:()=>Promise<T>){return withAuditWorkerTransaction(pool,identity(randomUUID()),'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:fixture.companyA,personId:fixture.u1.id,authMethod:'cookie'},work));}
async function observed(runner:ReturnType<typeof createIsolatedAuditJobRunner>,jobId:string){
 const samples:unknown[]=[],stats=async()=>(await pool.query("SELECT relname,last_analyze,last_autoanalyze,n_live_tup,n_mod_since_analyze FROM pg_stat_user_tables WHERE relname IN ('gl_journal_entries','gl_journal_lines')")).rows;
 const before=await stats(),started=Date.now();let active=false;
 const timer=setInterval(()=>{if(active)return;active=true;void pool.query("SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1",[`isaflow-audit:${jobId}`])
  .then(result=>{for(const row of result.rows){const {query,...metadata}=row;samples.push({...metadata,elapsedMs:Date.now()-started,shape:String(query).match(/(?:FROM|JOIN|UPDATE|INSERT INTO|DELETE FROM)\s+[a-zA-Z0-9_.]+/gi)??[String(query).split(/\s+/)[0]]});}})
  .catch((error:unknown)=>{samples.push({observerError:error instanceof Error?error.name:'unknown'});}).finally(()=>{active=false;});},500);
 try{return await runner.runIsolatedAuditJob(identity(jobId));}
 finally{clearInterval(timer);while(active)await new Promise(resolve=>setTimeout(resolve,10));
  if(process.env.ISAFLOW_AUDIT_SCALE_REPORT?.startsWith('/'))await writeFile(`${process.env.ISAFLOW_AUDIT_SCALE_REPORT}.${jobId}.queries.json`,JSON.stringify({jobId,before,after:await stats(),samples},null,2));
 }
}
beforeAll(async()=>{
 if(process.env.ISAFLOW_AUDIT_SCALE_OPT_IN!=='1'||![1000,100000].includes(records))throw new Error('Explicit bounded scale opt-in required');
 if(records===100000&&process.env.ISAFLOW_AUDIT_SCALE_LARGE_LEASE!=='100000')throw new Error('Separate large scale lease required');
 if(!process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT?.startsWith('/'))throw new Error('Absolute actual child artifact required');
 pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
 const existing=process.env.ISAFLOW_AUDIT_SCALE_EXISTING_JOB;
 if(existing){
  if(existing!=='9de9fc67-c72e-46fe-8204-d3b34b761351')throw new Error('Only the explicitly owned failed scale fixture may be resumed');
  const rows=(await pool.query('SELECT company_id,requester_person_id FROM control_audit_job_intents WHERE id=$1',[existing])).rows as Array<{company_id:string;requester_person_id:string}>;
  if(rows.length!==1)throw new Error('Owned scale fixture unavailable');fixture={companyA:rows[0]!.company_id,u1:{id:rows[0]!.requester_person_id}};census=await readScaleCensus(pool,fixture.companyA);
 }else{const created=await provisionForensicFixture(config);fixture=created;census=await seedAuditScale(pool,created,records);}
 process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 directory=await mkdtemp(join(tmpdir(),'isaflow-audit-scale-'));
},60000);
afterAll(async()=>{if(pool)await pool.end();if(directory)await rm(directory,{recursive:true,force:true});});
it('cold snapshot and export preserve the independent complete balanced journal population',async()=>{
 expect(census.headerCount+census.lineCount).toBe(records);expect(census.debit).toBe(census.credit);
 const runner=createIsolatedAuditJobRunner({nodePath:process.execPath,entryPath:process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT!});
 const snapshotJob=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 for(let n=0;n<2;n++)expect(await actor(()=>getAuditJob(requireControlTx(),snapshotJob.id))).toMatchObject({state:'queued',attempts:0});
 const captured=await observed(runner,snapshotJob.id);
 if(process.env.ISAFLOW_AUDIT_SCALE_REPORT?.startsWith('/'))await writeFile(process.env.ISAFLOW_AUDIT_SCALE_REPORT,JSON.stringify({phase:'snapshot',companyId:fixture.companyA,jobId:snapshotJob.id,records,census,result:captured.result,observation:captured.observation},null,2));
 expect(captured.result,JSON.stringify(captured)).toMatchObject({state:'succeeded',snapshotId:snapshotJob.id});
 const header=await actor(()=>readAuditSnapshotIndexHeader(requireControlTx(),snapshotJob.id));expect(header.counts.records).toBe(records);
 const job=await actor(()=>enqueueAuditExport(requireControlTx(),{snapshotId:snapshotJob.id,idempotencyKey:randomUUID()}));
 expect(await actor(()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({state:'queued',attempts:0});
 const exported=await observed(runner,job.id);
 if(process.env.ISAFLOW_AUDIT_SCALE_REPORT?.startsWith('/'))await writeFile(process.env.ISAFLOW_AUDIT_SCALE_REPORT,JSON.stringify({phase:'export',companyId:fixture.companyA,jobId:job.id,snapshotId:snapshotJob.id,records,census,snapshot:captured.observation,result:exported.result,observation:exported.observation},null,2));
 expect(exported.result,JSON.stringify(exported)).toMatchObject({state:'succeeded',exportId:job.id});
 const metadata:Array<{path:string;byteLength:number;sha256:string}>=[];let cursor:string|undefined,totalBytes=0,expectedFiles:number|undefined;
 do{
  const page=await actor(()=>getAuditExportFiles(requireControlTx(),{jobId:job.id,limit:2,...(cursor?{cursor}:{})}));
  if(expectedFiles!==undefined)expect(page.fileCount).toBe(expectedFiles);expectedFiles=page.fileCount;
  for(const file of page.files){
   expect(file.ordinal).toBe(metadata.length);
   const hash=createHash('sha256'),handle=await open(join(directory,String(file.ordinal)),'w');let length=0;
   try{for(let chunkOrdinal=0;chunkOrdinal<file.chunkCount;chunkOrdinal++){
    const chunk=await actor(()=>readAuditExportChunk(requireControlTx(),{jobId:job.id,fileOrdinal:file.ordinal,chunkOrdinal}));
    hash.update(chunk.bytes);length+=chunk.bytes.length;await handle.write(chunk.bytes);
   }}finally{await handle.close();}
   expect(length).toBe(file.byteLength);expect(hash.digest('hex')).toBe(file.sha256);totalBytes+=length;
   metadata.push({path:file.path,byteLength:file.byteLength,sha256:file.sha256});
  }cursor=page.nextCursor??undefined;
 }while(cursor);
 expect(metadata).toHaveLength(expectedFiles!);expect(new Set(metadata.map(file=>file.path)).size).toBe(metadata.length);
 const load=async(path:string)=>JSON.parse(await readFile(join(directory,String(metadata.findIndex(file=>file.path===path))),'utf8'));
 const snapshot=await load('snapshot.json') as AuditSnapshotData;
 expect(snapshot.records).toHaveLength(records);expect(createHash('sha256').update(canonicalJson(snapshot)).digest('hex')).toBe(header.canonicalHash);
 expect(scaleCensus(snapshot.records)).toEqual(census);
 const signed=await load('manifest.json') as AuthenticatedExportManifest;
 expect(createHash('sha256').update(signed.canonicalData).digest('hex')).toBe(signed.canonicalHash);
 expect(createHmac('sha256',process.env.CONTROL_SNAPSHOT_SIGNING_KEY!).update(canonicalJson({domain:'isaflow:audit-evidence-export:v1',keyId:signed.keyId,canonicalHash:signed.canonicalHash})).digest('hex')).toBe(signed.authentication);
 const manifest=JSON.parse(signed.canonicalData) as ExportManifest;
 expect(manifest.files.map(({path,byteLength,sha256})=>({path,byteLength,sha256}))).toEqual(metadata.filter(file=>file.path!=='manifest.json'));
 expect(manifest.populations).toEqual(snapshot.populations);
 expect((await runner.runIsolatedAuditJob(identity(job.id))).result).toEqual({state:'not_claimed'});
 const evidence={phase:'verified',companyId:fixture.companyA,jobId:job.id,snapshotId:snapshotJob.id,records,census,snapshot:captured.observation,export:exported.observation,totalBytes,fileCount:metadata.length};
 if(process.env.ISAFLOW_AUDIT_SCALE_REPORT?.startsWith('/'))await writeFile(process.env.ISAFLOW_AUDIT_SCALE_REPORT,JSON.stringify(evidence,null,2));
},180000);

it('independent census digest uses fixed code-unit order even when ambient collation differs',()=>{
 const records:AuditSnapshotData['records']=[{source:'journal_entry',id:'b',version:null,data:{}},{source:'journal_entry',id:'a',version:null,data:{}}];
 const expected=createHash('sha256').update('journal_entry:a\njournal_entry:b\n').digest('hex');
 expect(scaleCensus(records).identityHash).toBe(expected);
 const collation=vi.spyOn(String.prototype,'localeCompare').mockImplementation(function(this:string,other:string){return this<other?1:this>other?-1:0;});
 try{expect(scaleCensus(records).identityHash).toBe(expected);}finally{collation.mockRestore();}
});
