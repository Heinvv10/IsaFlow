import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {exportReadFixture} from '../../fixtures/auditExportReadFixture';
import {getAuditExportFiles,readAuditExportChunk} from '@/modules/accounting/services/controls/auditExportReadService';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {indexCryptography} from '@/modules/accounting/services/controls/auditSnapshotIndexCrypto';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture,material:Awaited<ReturnType<typeof exportReadFixture>>;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
afterAll(()=>pool.end());
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);material=await exportReadFixture(fixture.companyA,fixture.u1.id,fixture.u1.tokens[0]!.id);
 const {companyId,jobId,snapshotId,leaseId,canonicalSnapshotHash}=material.identity,r=material.intentRow;
 // Test-owned lifecycle setup, genuine authenticated producer material. Not worker-publication proof.
 for(const [id,kind] of [[snapshotId,'audit_snapshot'],[jobId,'audit_export']]){
  await pool.query('INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request) VALUES($1,$2,$3,$4,$2::uuid::text,$5,$6::jsonb)',
   [companyId,id,fixture.u1.id,kind,r.request_hash,JSON.stringify(kind==='audit_export'?r.protected_request:{})]);
  await pool.query('INSERT INTO control_audit_jobs(company_id,job_id) VALUES($1,$2)',[companyId,id]);
 }
 await pool.query("INSERT INTO control_audit_snapshots(company_id,id,job_id,requester_person_id,cutoff,canonical_hash,protected_snapshot) VALUES($1,$2,$2,$3,'2026-09-09',$4,'{}')",[companyId,snapshotId,fixture.u1.id,canonicalSnapshotHash]);
 await pool.query("UPDATE control_audit_jobs SET state='succeeded',result_snapshot_id=job_id,completed_at=clock_timestamp() WHERE company_id=$1 AND job_id=$2",[companyId,snapshotId]);
 await pool.query('INSERT INTO control_audit_snapshot_indexes(company_id,snapshot_id,protected_header) VALUES($1,$2,$3::jsonb)',[companyId,snapshotId,JSON.stringify(material.indexHeader)]);
 for(const row of material.rows){
  if(row.kind==='header')await pool.query('INSERT INTO control_audit_export_results(company_id,job_id,generation,lease_id,protected_header) VALUES($1,$2,1,$3,$4::jsonb)',[companyId,jobId,leaseId,JSON.stringify(row.envelope)]);
  if(row.kind==='file')await pool.query('INSERT INTO control_audit_export_files(company_id,job_id,generation,lease_id,file_ordinal,protected_file) VALUES($1,$2,1,$3,$4,$5::jsonb)',[companyId,jobId,leaseId,row.file.ordinal,JSON.stringify(row.envelope)]);
  if(row.kind==='chunk')await pool.query('INSERT INTO control_audit_export_chunks(company_id,job_id,generation,lease_id,file_ordinal,chunk_ordinal,protected_chunk) VALUES($1,$2,1,$3,$4,$5,$6::jsonb)',[companyId,jobId,leaseId,row.fileOrdinal,row.chunkOrdinal,JSON.stringify(row.envelope)]);
 }
 await pool.query("UPDATE control_audit_jobs SET state='succeeded',generation=1,result_export_id=job_id,completed_at=clock_timestamp() WHERE company_id=$1 AND job_id=$2",[companyId,jobId]);
});
function actor<T>(person:'u1'|'u2'|'u3',fn:()=>Promise<T>){const user=fixture[person];return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+10000,undefined,
 store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},fn));}
const page=(person:'u1'|'u2'|'u3'='u2',cursor?:string)=>actor(person,()=>getAuditExportFiles(requireControlTx(),{jobId:material.identity.jobId,limit:40,...cursor?{cursor}:{}}));
it('another current tenant member reads all111files and fullmanifest after originalgrantrevocation, without wholeblob',async()=>{
 const token=fixture.u1.tokens[0]!.id;await pool.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[fixture.companyA,token]);
 try{
  const files=[];let cursor:string|undefined;
  do{const result=await page('u2',cursor);expect(result.fileCount).toBe(111);files.push(...result.files);cursor=result.nextCursor??undefined;}while(cursor);
  expect(files.map(file=>file.ordinal)).toEqual(Array.from({length:111},(_,i)=>i));
  const file=files.find(f=>f.path==='manifest.json')!,parts:Buffer[]=[];
  for(let chunkOrdinal=0;chunkOrdinal<file.chunkCount;chunkOrdinal++){
   const result=await actor('u2',()=>readAuditExportChunk(requireControlTx(),{jobId:material.identity.jobId,fileOrdinal:file.ordinal,chunkOrdinal}));
   expect(result.bytes.length).toBeLessThanOrEqual(262144);parts.push(Buffer.from(result.bytes));
  }
  expect(JSON.parse(Buffer.concat(parts).toString())).toEqual(material.bundle.manifest);
 }finally{await pool.query('UPDATE personal_access_tokens SET revoked_at=NULL WHERE company_id=$1 AND id=$2',[fixture.companyA,token]);}
});
it('rejects foreign tenant and currently denied source rights',async()=>{
 await expect(page('u3')).rejects.toThrow(/unavailable|not found/i);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[fixture.companyA,fixture.u2.id]);
 try{await expect(page()).rejects.toThrow(/permission/i);}finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u2.id]);}
});
it('refuses a missing file descriptor rather than skipping a page gap',async()=>{
 const client=await pool.connect();try{await client.query('BEGIN');
  await client.query('DELETE FROM control_audit_export_chunks WHERE company_id=$1 AND job_id=$2 AND file_ordinal=1',[fixture.companyA,material.identity.jobId]);
  await client.query('DELETE FROM control_audit_export_files WHERE company_id=$1 AND job_id=$2 AND file_ordinal=1',[fixture.companyA,material.identity.jobId]);
  await client.query('COMMIT');
  await expect(page()).rejects.toThrow(/incomplete/);
 }finally{client.release();
  for(const row of material.rows){if(row.kind==='file'&&row.file.ordinal===1)await pool.query('INSERT INTO control_audit_export_files(company_id,job_id,generation,lease_id,file_ordinal,protected_file) VALUES($1,$2,1,$3,1,$4::jsonb)',[fixture.companyA,material.identity.jobId,material.identity.leaseId,JSON.stringify(row.envelope)]);
   if(row.kind==='chunk'&&row.fileOrdinal===1)await pool.query('INSERT INTO control_audit_export_chunks(company_id,job_id,generation,lease_id,file_ordinal,chunk_ordinal,protected_chunk) VALUES($1,$2,1,$3,1,$4,$5::jsonb)',[fixture.companyA,material.identity.jobId,material.identity.leaseId,row.chunkOrdinal,JSON.stringify(row.envelope)]);}
 }
});
it('refuses authenticated wrong-generation header and tampered chunk',async()=>{
 const {companyId,jobId}=material.identity,original=material.intentRow.protected_header,crypto=indexCryptography();
 const body=crypto.open('export-header',original) as Record<string,unknown>;
 await pool.query('UPDATE control_audit_export_results SET protected_header=$3::jsonb WHERE company_id=$1 AND job_id=$2',[companyId,jobId,JSON.stringify(crypto.seal('export-header',{...body,generation:2}))]);
 try{await expect(page()).rejects.toThrow(/identity/);}finally{await pool.query('UPDATE control_audit_export_results SET protected_header=$3::jsonb WHERE company_id=$1 AND job_id=$2',[companyId,jobId,JSON.stringify(original)]);}
 const chunk=material.rows.find(r=>r.kind==='chunk')!;
 await pool.query("UPDATE control_audit_export_chunks SET protected_chunk='{}' WHERE company_id=$1 AND job_id=$2 AND file_ordinal=0 AND chunk_ordinal=0",[companyId,jobId]);
 try{await expect(actor('u2',()=>readAuditExportChunk(requireControlTx(),{jobId,fileOrdinal:0,chunkOrdinal:0}))).rejects.toThrow();}
 finally{await pool.query('UPDATE control_audit_export_chunks SET protected_chunk=$3::jsonb WHERE company_id=$1 AND job_id=$2 AND file_ordinal=0 AND chunk_ordinal=0',[companyId,jobId,JSON.stringify(chunk.envelope)]);}
});
it('does not expose stored output before successful publication',async()=>{
 const {companyId,jobId}=material.identity;
 await pool.query("UPDATE control_audit_jobs SET state='failed',result_export_id=NULL WHERE company_id=$1 AND job_id=$2",[companyId,jobId]);
 try{await expect(page()).rejects.toThrow(/unavailable/);}finally{await pool.query("UPDATE control_audit_jobs SET state='succeeded',result_export_id=job_id WHERE company_id=$1 AND job_id=$2",[companyId,jobId]);}
});
