import {afterAll,beforeAll,expect,it} from 'vitest';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,open,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {evidenceScaleStorage,ORIGINAL_BYTES,type Original} from './auditEvidenceScaleFixture';
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
let pool:Pool,fixture:ForensicFixture,directory:string,storage:Awaited<ReturnType<typeof evidenceScaleStorage>>;
const originals:Original[]=[];
const identity=(jobId:string)=>({companyId:fixture.companyA,personId:fixture.u1.id,jobId});
async function actor<T>(work:()=>Promise<T>){return withAuditWorkerTransaction(pool,identity(randomUUID()),'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:fixture.companyA,personId:fixture.u1.id,authMethod:'cookie'},work));}
beforeAll(async()=>{
 if(process.env.ISAFLOW_AUDIT_EVIDENCE_SCALE_LEASE!=='100MiB')throw new Error('Explicit evidence scale lease required');
 if(!process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT?.startsWith('/'))throw new Error('Absolute actual child artifact required');
 pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});fixture=await provisionForensicFixture(config);
 storage=await evidenceScaleStorage();
 for(let i=0;i<10;i++)originals.push(await storage.seed(pool,fixture.companyA,ORIGINAL_BYTES,i+1));
 process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 directory=await mkdtemp(join(tmpdir(),'isaflow-evidence-scale-'));
},60000);
afterAll(async()=>{if(storage)await storage.close();if(pool)await pool.end();if(directory)await rm(directory,{recursive:true,force:true});});
it('retains and exports exact 100 MiB originals, then atomically refuses one excess byte',async()=>{
 expect(originals.reduce((sum,item)=>sum+item.byteLength,0)).toBe(100*1024*1024);
 const runner=createIsolatedAuditJobRunner({nodePath:process.execPath,entryPath:process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT!,workerClass:'audit'});
 const snapshotJob=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['bank'],checks:[],idempotencyKey:randomUUID()}));
 for(let n=0;n<2;n++)expect(await actor(()=>getAuditJob(requireControlTx(),snapshotJob.id))).toMatchObject({state:'queued',attempts:0});
 expect(storage.requests).toBe(0);
 const captured=await runner.runIsolatedAuditJob(identity(snapshotJob.id));
 if(process.env.ISAFLOW_AUDIT_SCALE_REPORT?.startsWith('/'))await writeFile(process.env.ISAFLOW_AUDIT_SCALE_REPORT,JSON.stringify({phase:'snapshot',companyId:fixture.companyA,jobId:snapshotJob.id,originals,result:captured.result,observation:captured.observation},null,2));
 expect(captured.result,JSON.stringify(captured)).toMatchObject({state:'succeeded',snapshotId:snapshotJob.id});
 const header=await actor(()=>readAuditSnapshotIndexHeader(requireControlTx(),snapshotJob.id));expect(header.counts.records).toBeGreaterThanOrEqual(10);expect(storage.requests).toBe(10);
 const job=await actor(()=>enqueueAuditExport(requireControlTx(),{snapshotId:snapshotJob.id,idempotencyKey:randomUUID()}));
 expect(await actor(()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({state:'queued',attempts:0});
 const exported=await runner.runIsolatedAuditJob(identity(job.id));
 if(process.env.ISAFLOW_AUDIT_SCALE_REPORT?.startsWith('/'))await writeFile(process.env.ISAFLOW_AUDIT_SCALE_REPORT,JSON.stringify({phase:'export',companyId:fixture.companyA,jobId:job.id,snapshotId:snapshotJob.id,originals,snapshot:captured.observation,result:exported.result,observation:exported.observation},null,2));
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
 expect(snapshot.evidence).toHaveLength(10);expect(createHash('sha256').update(canonicalJson(snapshot)).digest('hex')).toBe(header.canonicalHash);
 expect(snapshot.evidence.map(({id,byteLength,sha256})=>({id,byteLength,sha256})).sort((a,b)=>a.id<b.id?-1:1)).toEqual([...originals].sort((a,b)=>a.id<b.id?-1:1));
 const signed=await load('manifest.json') as AuthenticatedExportManifest;
 expect(createHash('sha256').update(signed.canonicalData).digest('hex')).toBe(signed.canonicalHash);
 expect(createHmac('sha256',process.env.CONTROL_SNAPSHOT_SIGNING_KEY!).update(canonicalJson({domain:'isaflow:audit-evidence-export:v1',keyId:signed.keyId,canonicalHash:signed.canonicalHash})).digest('hex')).toBe(signed.authentication);
 const manifest=JSON.parse(signed.canonicalData) as ExportManifest;
 expect(manifest.files.map(({path,byteLength,sha256})=>({path,byteLength,sha256}))).toEqual(metadata.filter(file=>file.path!=='manifest.json'));
 expect(manifest.populations).toEqual(snapshot.populations);
 for(const original of originals){const item=manifest.evidence.find(row=>row.id===original.id);expect(item).toMatchObject(original);expect(metadata.find(file=>file.path===item!.path)).toMatchObject({byteLength:original.byteLength,sha256:original.sha256});}
 expect((await runner.runIsolatedAuditJob(identity(job.id))).result).toEqual({state:'not_claimed'});
 const pdf=await readFile(join(directory,String(metadata.findIndex(file=>file.path==='evidence.pdf'))));
 const pdfPages=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)??[]).length;expect(pdfPages).toBeGreaterThan(0);
 const evidence={phase:'verified',companyId:fixture.companyA,jobId:job.id,snapshotId:snapshotJob.id,originals,snapshot:captured.observation,export:exported.observation,totalBytes,fileCount:metadata.length,pdfPages};
 if(process.env.ISAFLOW_AUDIT_SCALE_REPORT?.startsWith('/'))await writeFile(process.env.ISAFLOW_AUDIT_SCALE_REPORT,JSON.stringify(evidence,null,2));
 await storage.seed(pool,fixture.companyA,1,11);
 const request={cutoff:'2026-09-09',sources:['bank'] as ['bank'],checks:[],idempotencyKey:randomUUID()};
 const overflow=await actor(()=>enqueueAuditSnapshot(requireControlTx(),request));
 const refused=await runner.runIsolatedAuditJob(identity(overflow.id));
 if(process.env.ISAFLOW_AUDIT_SCALE_REPORT?.startsWith('/'))await writeFile(`${process.env.ISAFLOW_AUDIT_SCALE_REPORT}.overflow.json`,JSON.stringify({companyId:fixture.companyA,jobId:overflow.id,originalBytes:100*1024*1024+1,...refused},null,2));
 expect(refused.result).toMatchObject({state:'failed',code:'RESOURCE_LIMIT',failureRecorded:true});
 expect(storage.requests).toBe(21);
 expect((await actor(()=>enqueueAuditSnapshot(requireControlTx(),request))).id).toBe(overflow.id);
 expect((await runner.runIsolatedAuditJob(identity(overflow.id))).result).toEqual({state:'not_claimed'});
 for(const query of [
  'SELECT count(*)::int AS count FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',
  'SELECT count(*)::int AS count FROM control_audit_snapshot_artifacts WHERE company_id=$1 AND snapshot_id=$2',
  'SELECT count(*)::int AS count FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',
 ])expect((await pool.query(query,[fixture.companyA,overflow.id])).rows[0].count).toBe(0);
},180000);
