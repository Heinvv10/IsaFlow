import {afterAll,beforeAll,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {createAuditJobPoller} from '@/modules/accounting/services/controls/auditJobPoller';
import {verifyAuditEvidenceBundle,type AuthenticatedExportManifest,type EvidenceExportFile} from '@/modules/accounting/services/controls/auditEvidenceExportMaterial';
import type {SnapshotIndexHeader,SnapshotIndexItem} from '@/modules/accounting/services/controls/auditSnapshotIndexContract';
type Job={id:string;state:string;attempts:number;resultExportId?:string};
type Files={files:Array<Omit<EvidenceExportFile,'bytes'>&{ordinal:number;chunkCount:number}>;nextCursor:string|null;fileCount:number};
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>;
const request={cutoff:'2026-09-09',sources:['journals','bank','payroll'],checks:[]};
beforeAll(async()=>{f=await auditDeliveryFixture();},30000);afterAll(async()=>{if(f)await f.close();});
it('actual PAT HTTP delivers cold snapshot and poller export with authenticated original bytes',async()=>{
 const job=await f.call<Job>('audit_snapshot',{...request,idempotency_key:randomUUID(),company_id:f.fixture.companyA});
 for(let i=0;i<2;i++)expect(await f.call<Job>('audit_job_status',{job_id:job.id})).toMatchObject({state:'queued',attempts:0});
 expect((await f.pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.fixture.companyA,job.id])).rows).toEqual([]);
 expect(await runAuditJob({companyId:f.fixture.companyA,personId:f.fixture.u1.id,jobId:job.id},{pool:f.pool,workerClass:'audit'})).toMatchObject({state:'succeeded'});
 const header=await f.call<SnapshotIndexHeader>('audit_snapshot_manifest',{snapshot_id:job.id});expect(header.counts.records).toBeGreaterThan(0);expect(header.counts.evidence).toBeGreaterThan(0);
 const retained:Buffer[]=[];
 for(const section of ['records','evidence'] as const){
  let cursor:string|undefined;
  do{
   const page=await f.call<{items:SnapshotIndexItem[];nextCursor:string|null}>('audit_snapshot_items',{snapshot_id:job.id,section,limit:1,...(cursor?{cursor}:{})});
   for(const item of page.items){const pieces:Buffer[]=[];
    for(let n=0;n<item.chunkCount;n++){const chunk=await f.call<{bytesBase64:string}>('audit_snapshot_chunk',{snapshot_id:job.id,section,ordinal:item.ordinal,chunk_ordinal:n});pieces.push(Buffer.from(chunk.bytesBase64,'base64'));}
    const bytes=Buffer.concat(pieces);expect(bytes.length).toBe(item.byteLength);expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.sha256);retained.push(bytes);
   }cursor=page.nextCursor??undefined;
  }while(cursor);
 }
 const journalRecord=retained.map(bytes=>JSON.parse(bytes.toString())).find(record=>record.source==='journal_entry'&&record.id===f.journal);
 expect(journalRecord.data.entry_date).toBe('2026-09-09');
 await f.pool.query("UPDATE gl_journal_entries SET entry_date='2026-09-10' WHERE company_id=$1 AND id=$2",[f.fixture.companyA,f.journal]);
 await f.pool.query("UPDATE bank_transaction_attachments SET file_url='data:text/plain;base64,Y2hhbmdlZA==' WHERE id=$1 AND bank_transaction_id=$2",[f.attachment,f.bank]);
 const exported=await f.call<Job>('export_audit_evidence',{snapshot_id:job.id,idempotency_key:randomUUID(),company_id:f.fixture.companyA});
 expect(await f.call<Job>('audit_job_status',{job_id:exported.id})).toMatchObject({state:'queued',attempts:0});
 await createAuditJobPoller({companyIds:[f.fixture.companyA],batchSize:10},{pool:f.pool,executeJob:(identity,options)=>runAuditJob(identity,{pool:f.pool,...options,workerClass:'audit'})}).pollOnce();
 expect(await f.call<Job>('audit_job_status',{job_id:exported.id})).toMatchObject({state:'succeeded',resultExportId:exported.id});
 const files:EvidenceExportFile[]=[];let cursor:string|undefined;
 do{const page=await f.call<Files>('audit_export_files',{job_id:exported.id,limit:2,...(cursor?{cursor}:{})});
  for(const file of page.files){const parts:Buffer[]=[];for(let n=0;n<file.chunkCount;n++)parts.push(Buffer.from((await f.call<{bytesBase64:string}>('audit_export_chunk',{job_id:exported.id,file_ordinal:file.ordinal,chunk_ordinal:n})).bytesBase64,'base64'));
   const bytes=Buffer.concat(parts);expect(bytes.length).toBe(file.byteLength);expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);files.push({path:file.path,mediaType:file.mediaType,sha256:file.sha256,byteLength:file.byteLength,bytes});
  }cursor=page.nextCursor??undefined;
 }while(cursor);
 const manifest=JSON.parse(Buffer.from(files.find(file=>file.path==='manifest.json')!.bytes).toString()) as AuthenticatedExportManifest;
 const verified=verifyAuditEvidenceBundle({companyId:f.fixture.companyA,snapshotId:job.id,canonicalSnapshotHash:header.canonicalHash,manifest,files:files.filter(file=>file.path!=='manifest.json')},{companyId:f.fixture.companyA,snapshotId:job.id});
 expect(verified.canonicalSnapshotHash).toBe(header.canonicalHash);
 const snapshot=JSON.parse(Buffer.from(files.find(file=>file.path==='snapshot.json')!.bytes).toString());expect(snapshot.records.find((record:{id:string})=>record.id===f.journal)).toEqual(journalRecord);
 expect(files.some(file=>Buffer.from(file.bytes).equals(f.bytes))).toBe(true);
 expect(await runAuditJob({companyId:f.fixture.companyA,personId:f.fixture.u1.id,jobId:exported.id},{pool:f.pool,workerClass:'audit'})).toEqual({state:'not_claimed'});
 expect((await f.rpc('audit_snapshot_manifest',{snapshot_id:job.id},'u3')).result?.isError).toBe(true);
},90000);
it('same-key concurrent retry, separate people and revoked payroll replay use current HTTP authority',async()=>{
 const args={...request,idempotency_key:randomUUID()};
 const [a,b]=await Promise.all([f.call<Job>('audit_snapshot',args),f.call<Job>('audit_snapshot',args)]);expect(a.id).toBe(b.id);
 const other=await f.call<Job>('audit_snapshot',args,'u2');expect(other.id).not.toBe(a.id);
 const rows=(await f.pool.query('SELECT job_id FROM control_audit_jobs WHERE company_id=$1 AND job_id=ANY($2::uuid[])',[f.fixture.companyA,[a.id,other.id]])).rows;expect(rows).toHaveLength(2);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[f.fixture.companyA,f.fixture.u1.id]);
 try{const denied=await f.rpc('audit_snapshot',args,'u1',true);expect(denied.result?.isError).toBe(true);}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[f.fixture.companyA,f.fixture.u1.id]);}
 expect(await f.call<Job>('audit_job_status',{job_id:a.id})).toMatchObject({state:'queued',attempts:0});
 const receipts=(await f.pool.query("SELECT r.status FROM mcp_invocation_receipts r JOIN mcp_invocation_attempts a ON a.company_id=r.company_id AND a.id=r.attempt_id WHERE a.company_id=$1 AND a.person_id=$2 AND a.tool='audit_snapshot'",[f.fixture.companyA,f.fixture.u1.id])).rows;
 expect(receipts.some(row=>row.status==='rejected')).toBe(true);
},30000);
