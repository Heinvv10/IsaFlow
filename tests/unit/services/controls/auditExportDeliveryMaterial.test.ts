import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {renderAuditEvidence} from '@/modules/accounting/services/controls/auditEvidenceExportService';
import {exportDeliveryRows,openExportDeliveryHeader,openExportDeliveryFile,openExportDeliveryChunk} from '@/modules/accounting/services/controls/auditExportDeliveryMaterial';
import type {ExportDeliveryRow} from '@/modules/accounting/services/controls/auditExportDeliveryContract';
import {indexCryptography} from '@/modules/accounting/services/controls/auditSnapshotIndexCrypto';
import {sealExportManifest,type ExportManifest} from '@/modules/accounting/services/controls/auditEvidenceExportMaterial';
import {assertDeliverySize} from '@/modules/accounting/services/controls/auditExportDeliveryValidation';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
afterEach(()=>vi.unstubAllEnvs());
it('admits manifest sizes above 200 MiB under the aggregate contract without allocating their bytes',()=>{
 for(const bytes of [200*1024*1024+1,1073741824])expect(()=>assertDeliverySize(bytes)).not.toThrow();
 for(const bytes of [-1,NaN,Infinity,1.5,1073741825])expect(()=>assertDeliverySize(bytes)).toThrow();
});
async function fixture(payroll=false,evidenceRepeats=50000){
 vi.stubEnv('ENCRYPTION_KEY','synthetic-delivery-encryption-key-0000000000001');
 vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-delivery-signing-key-000000000000001');
 const companyId=randomUUID(),snapshotId=randomUUID(),bytes=Buffer.from('中文\u0000'.repeat(evidenceRepeats));
 const sealed=sealAuditSnapshot({version:1,companyId,snapshotId,cutoff:'2026-09-09',capturedAt:'2026-09-09T01:00:00Z',
  records:[],populations:['journal_entry','journal_line',...payroll?['payroll_run','payroll_run_line']:[]].map(source=>({source,count:0,excludedCount:0,exclusions:[]})),
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
 const expected=input.bundle.files.map(file=>Buffer.from(file.bytes));
 const iterator=exportDeliveryRows(input.bundle,input.identity,['read:reports']);const first=await iterator.next();expect(first.value?.kind).toBe('header');
 input.bundle.files.forEach(file=>file.bytes.fill(0));
 const rows=[];for await(const row of iterator)rows.push(row);
 if(first.value?.kind!=='header')throw Error();const header=openExportDeliveryHeader(first.value.envelope,input.identity);
 for(const row of rows){if(row.kind!=='file'||row.file.path==='manifest.json')continue;const file=openExportDeliveryFile(row.envelope,header,row.file.ordinal);
  const bytes=Buffer.concat(rows.filter(r=>r.kind==='chunk'&&r.fileOrdinal===file.ordinal).map(r=>{if(r.kind!=='chunk')throw Error();return Buffer.from(openExportDeliveryChunk(r.envelope,file,r.chunkOrdinal));}));
  expect(bytes).toEqual(expected[file.ordinal]);
 }
});
it('observes a real timer abort before publishing anything',async()=>{
 // Enough real byte work that the native timer becomes due during verification, even with a warm KDF cache.
 const input=await fixture(false,2000000),controller=new AbortController();const timer=setTimeout(()=>controller.abort(),0);
 try{await expect(exportDeliveryRows(input.bundle,input.identity,['read:reports'],{signal:controller.signal}).next()).rejects.toThrow(/abort/i);}finally{clearTimeout(timer);}
});
it('derives payroll permission from authenticated zero-count source families',async()=>{
 const input=await fixture(true);
 await expect(exportDeliveryRows(input.bundle,input.identity,['read:reports']).next()).rejects.toThrow(/permissions/);
 const first=await exportDeliveryRows(input.bundle,input.identity,['read:reports','read:payroll']).next();
 expect(first.value).toMatchObject({kind:'header',header:{permissions:['read:payroll','read:reports']}});
 const manifest=JSON.parse(input.bundle.manifest.canonicalData) as ExportManifest;manifest.populations=manifest.populations.filter(p=>!p.source.startsWith('payroll'));
 input.bundle.manifest=sealExportManifest(manifest);
 await expect(exportDeliveryRows(input.bundle,input.identity,['read:reports']).next()).rejects.toThrow(/population/);
});
it('rejects authenticated malformed chunk length/hash and cross-file swaps',async()=>{
 const input=await fixture(),rows=await collect(input),h=rows.find(r=>r.kind==='header')!;
 if(h.kind!=='header')throw Error();const header=openExportDeliveryHeader(h.envelope,input.identity);
 const fs=rows.filter(r=>r.kind==='file'),cs=rows.filter(r=>r.kind==='chunk');
 const file=openExportDeliveryFile(fs[0]!.envelope,header,0),other=openExportDeliveryFile(fs[1]!.envelope,header,1),crypto=indexCryptography();
 expect(()=>openExportDeliveryChunk(cs[0]!.envelope,other,0)).toThrow();
 const value=crypto.open('export-chunk',cs[0]!.envelope) as Record<string,unknown>;
 expect(()=>openExportDeliveryChunk(crypto.seal('export-chunk',{...value,bytesBase64:'eA=='}),file,0)).toThrow();
 expect(()=>openExportDeliveryChunk(crypto.seal('export-chunk',{...value,sha256:'0'.repeat(64)}),file,0)).toThrow();
});
it('enforces the exact file/aggregate boundaries without allocating a gigabyte',async()=>{
 const input=await fixture(),crypto=indexCryptography();
 const raw={...input.identity,version:1,fileCount:100006,totalBytes:1073741824,permissions:['read:reports']};
 const header=openExportDeliveryHeader(crypto.seal('export-header',raw),input.identity);expect(header.fileCount).toBe(100006);
 for(const changed of [{fileCount:100007},{totalBytes:1073741825}])expect(()=>openExportDeliveryHeader(crypto.seal('export-header',{...raw,...changed}),input.identity)).toThrow();
 const huge={...input.identity,ordinal:100005,path:'manifest.json',mediaType:'application/json',byteLength:1073741824,sha256:'0'.repeat(64),chunkCount:4096};
 expect(openExportDeliveryFile(crypto.seal('export-file',huge),header,100005).chunkCount).toBe(4096);
 expect(()=>openExportDeliveryFile(crypto.seal('export-file',{...huge,byteLength:1073741825}),header,100005)).toThrow();
});
it('uses intrinsic byte length without invoking decorators and cancels between yielded rows',async()=>{
 const input=await fixture();let calls=0;Object.defineProperty(input.bundle.files[0]!.bytes,'byteLength',{get(){calls++;return NaN;}});
 const controller=new AbortController(),iterator=exportDeliveryRows(input.bundle,input.identity,['read:reports'],{signal:controller.signal});
 expect((await iterator.next()).value?.kind).toBe('header');expect(calls).toBe(0);
 controller.abort();await expect(iterator.next()).rejects.toThrow(/abort/);
});
