import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {renderAuditEvidence} from '@/modules/accounting/services/controls/auditEvidenceExportService';
import {exportDeliveryRows,openExportDeliveryHeader,openExportDeliveryFile,openExportDeliveryChunk} from '@/modules/accounting/services/controls/auditExportDeliveryMaterial';
import type {ExportDeliveryRow} from '@/modules/accounting/services/controls/auditExportDeliveryContract';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
afterEach(()=>vi.unstubAllEnvs());
async function fixture(){
 vi.stubEnv('ENCRYPTION_KEY','synthetic-delivery-encryption-key-0000000000001');
 vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-delivery-signing-key-000000000000001');
 const companyId=randomUUID(),snapshotId=randomUUID(),bytes=Buffer.from('中文\u0000'.repeat(50000));
 const sealed=sealAuditSnapshot({version:1,companyId,snapshotId,cutoff:'2026-09-09',capturedAt:'2026-09-09T01:00:00Z',
  records:[],populations:[{source:'journal_entry',count:0,excludedCount:0,exclusions:[]},{source:'journal_line',count:0,excludedCount:0,exclusions:[]}],
  checks:[],evidence:[{id:'source',sha256:hash(bytes),byteLength:bytes.length,mediaType:'application/octet-stream'}],coverage:[],missingSources:[]});
 const bundle=await renderAuditEvidence(sealed,[{id:'source',bytes}],{companyId,snapshotId});
 return{bundle,identity:{companyId,snapshotId,canonicalSnapshotHash:sealed.canonicalHash,jobId:randomUUID(),leaseId:randomUUID(),generation:1}};
}
async function collect(input:Awaited<ReturnType<typeof fixture>>){const rows:ExportDeliveryRow[]=[];for await(const row of exportDeliveryRows(input.bundle,input.identity,['read:reports']))rows.push(row);return rows;}
it('reconstructs every actual rendered file and complete signed manifest with bounded chunks',async()=>{
 const input=await fixture(),rows=await collect(input),first=rows[0]!;expect(first.kind).toBe('header');if(first.kind!=='header')throw Error();
 const header=openExportDeliveryHeader(first.envelope,input.identity);expect(header.fileCount).toBe(input.bundle.files.length+1);
 const decoded=new Map<string,Buffer>();
 for(const row of rows){if(row.kind!=='file')continue;const file=openExportDeliveryFile(row.envelope,header,row.file.ordinal);
  const chunks=rows.filter(r=>r.kind==='chunk'&&r.fileOrdinal===file.ordinal).map(r=>{if(r.kind!=='chunk')throw Error();const bytes=openExportDeliveryChunk(r.envelope,file,r.chunkOrdinal);expect(bytes.length).toBeLessThanOrEqual(262144);return Buffer.from(bytes);});
  const bytes=Buffer.concat(chunks);expect(bytes.length).toBe(file.byteLength);expect(hash(bytes)).toBe(file.sha256);decoded.set(file.path,bytes);
 }
 for(const file of input.bundle.files)expect(decoded.get(file.path)).toEqual(Buffer.from(file.bytes));
 expect(JSON.parse(decoded.get('manifest.json')!.toString())).toEqual(input.bundle.manifest);
 expect(header.totalBytes).toBe([...decoded.values()].reduce((n,b)=>n+b.length,0));
});
it('refuses wrong identities, reduced permissions and changed final byte before yielding a header',async()=>{
 const input=await fixture();
 await expect(exportDeliveryRows(input.bundle,{...input.identity,canonicalSnapshotHash:'0'.repeat(64)},['read:reports']).next()).rejects.toThrow();
 await expect(exportDeliveryRows(input.bundle,input.identity,[]).next()).rejects.toThrow();
 input.bundle.files.at(-1)!.bytes[0]^=1;
 await expect(exportDeliveryRows(input.bundle,input.identity,['read:reports']).next()).rejects.toThrow();
});
it('rejects tampering, wrong generation, detached brands, spliced chunk and truncated ciphertext',async()=>{
 const input=await fixture(),rows=await collect(input),head=rows.find(r=>r.kind==='header')!,fileRow=rows.find(r=>r.kind==='file')!,chunkRow=rows.find(r=>r.kind==='chunk')!;
 if(head.kind!=='header'||fileRow.kind!=='file'||chunkRow.kind!=='chunk')throw Error();
 expect(()=>openExportDeliveryHeader(head.envelope,{...input.identity,generation:2})).toThrow();
 const header=openExportDeliveryHeader(head.envelope,input.identity);
 expect(()=>openExportDeliveryFile(fileRow.envelope,{...header},0)).toThrow();
 const file=openExportDeliveryFile(fileRow.envelope,header,0);
 expect(()=>openExportDeliveryChunk(chunkRow.envelope,{...file},0)).toThrow();
 expect(()=>openExportDeliveryChunk(chunkRow.envelope,file,1)).toThrow();
 expect(()=>openExportDeliveryChunk({...chunkRow.envelope,ciphertext:chunkRow.envelope.ciphertext.slice(0,-2)},file,0)).toThrow();
 expect(()=>openExportDeliveryFile(head.envelope,header,0)).toThrow();
});
it('detaches bytes before header and never invokes caller accessors',async()=>{
 const input=await fixture();let calls=0;
 await expect(exportDeliveryRows({...input.bundle,get files(){calls++;return input.bundle.files;}},input.identity,['read:reports']).next()).rejects.toThrow();expect(calls).toBe(0);
 const iterator=exportDeliveryRows(input.bundle,input.identity,['read:reports']);const first=await iterator.next();expect(first.value?.kind).toBe('header');
 input.bundle.files.forEach(file=>file.bytes.fill(0));
 const rows=[];for await(const row of iterator)rows.push(row);expect(rows.length).toBeGreaterThan(0);
});
it('observes a real timer abort before publishing anything',async()=>{
 const input=await fixture(),controller=new AbortController();const timer=setTimeout(()=>controller.abort(),0);
 try{await expect(exportDeliveryRows(input.bundle,input.identity,['read:reports'],{signal:controller.signal}).next()).rejects.toThrow(/abort/i);}finally{clearTimeout(timer);}
});
