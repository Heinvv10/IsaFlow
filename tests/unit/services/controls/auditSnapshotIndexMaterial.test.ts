import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {buildSnapshotIndex,openSnapshotIndexHeader,openSnapshotIndexItem,openSnapshotIndexChunk} from '@/modules/accounting/services/controls/auditSnapshotIndexMaterial';
const companyId='00000000-0000-4000-8000-000000000001',snapshotId='00000000-0000-4000-8000-000000000002';
const identity={companyId,snapshotId},hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
beforeEach(()=>{vi.stubEnv('ENCRYPTION_KEY','synthetic-index-encryption-key-00000000001');vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-index-signing-key-00000000000001');});
afterEach(()=>vi.unstubAllEnvs());
function input(count=2,large=false){
 const bytes=Buffer.from('retained exact bytes'),records=Array.from({length:count},(_,i)=>({source:'journal_entry',id:`row-${i}`,version:1,data:{secret_reference:'preserve me',description:large?'é'.repeat(200000):'original'}}));
 const data={version:1 as const,...identity,cutoff:'2026-09-09',capturedAt:'2026-09-10T01:00:00.000Z',records,
  populations:[{source:'journal_entry',count,excludedCount:0,exclusions:[]},{source:'journal_line',count:0,excludedCount:0,exclusions:[]}],
  checks:[{checkId:'journal_risk_checks',checkVersion:1,status:'unknown' as const,populationCount:count,excludedCount:0,findingCount:1,
   amountTotals:{ZAR:'123.45'},findings:[{key:'missing',message:'Missing prior evidence'}],nextCursor:null,coverage:[],missingSources:['prior evidence'],
   capturedAt:'2026-09-10T01:00:00.000Z',cutoff:'2026-09-09',sourceVersions:[]}],
  evidence:[{id:'source',sha256:hash(bytes),byteLength:bytes.length,mediaType:'text/plain'}],
  evidenceGaps:[{id:'missing-source',reason:'original unavailable',relations:[]}],coverage:[],missingSources:['prior evidence']};
 return{data,sealed:sealAuditSnapshot(data),artifacts:[{id:'source',bytes}]};
}
it('authenticates exact complete items and keeps findings independently addressable',async()=>{
 const value=input(),built=await buildSnapshotIndex(value.sealed,value.artifacts,['read:reports']);
 const header=openSnapshotIndexHeader(built.protectedHeader,identity);
 expect(header.counts).toEqual({records:2,checks:1,findings:1,evidence:1,gaps:1});
 const items=built.items.map(stored=>{
  const item=openSnapshotIndexItem(stored.protectedItem,header,stored.section,stored.ordinal);
  const bytes=Buffer.concat(stored.chunks.map((chunk,index)=>Buffer.from(openSnapshotIndexChunk(chunk,item,index))));
  expect(bytes.length).toBe(item.byteLength);expect(hash(bytes)).toBe(item.sha256);return{section:item.section,data:JSON.parse(bytes.toString())};
 });
 expect(items.filter(item=>item.section==='records').map(item=>item.data)).toEqual(value.data.records);
 expect(items.find(item=>item.section==='checks')!.data).not.toHaveProperty('findings');
 expect(items.find(item=>item.section==='findings')!.data).toEqual({checkId:'journal_risk_checks',findingIndex:0,data:value.data.checks[0]!.findings[0]});
 expect(items.find(item=>item.section==='gaps')!.data).toEqual(value.data.evidenceGaps[0]);
 expect(Buffer.from(items.find(item=>item.section==='evidence')!.data.bytesBase64,'base64')).toEqual(value.artifacts[0]!.bytes);
});
it('splits an oversized item on byte boundaries without losing UTF8 data',async()=>{
 const value=input(1,true),built=await buildSnapshotIndex(value.sealed,value.artifacts,['read:reports']);
 const header=openSnapshotIndexHeader(built.protectedHeader,identity),stored=built.items[0]!;
 const item=openSnapshotIndexItem(stored.protectedItem,header,'records',0);expect(item.chunkCount).toBeGreaterThan(1);
 const chunks=stored.chunks.map((chunk,index)=>openSnapshotIndexChunk(chunk,item,index));
 expect(chunks.every(chunk=>chunk.byteLength<=262144)).toBe(true);
 expect(Buffer.concat(chunks).toString()).toBe(canonicalJson(value.data.records[0]));
});
it('refuses tampering, swaps, truncation and forged descriptor capabilities',async()=>{
 const value=input(),built=await buildSnapshotIndex(value.sealed,value.artifacts,['read:reports']);
 const header=openSnapshotIndexHeader(built.protectedHeader,identity),stored=built.items[0]!;
 const item=openSnapshotIndexItem(stored.protectedItem,header,'records',0);
 expect(()=>openSnapshotIndexHeader(built.protectedHeader,{...identity,companyId:snapshotId})).toThrow();
 expect(()=>openSnapshotIndexHeader({...built.protectedHeader,ciphertext:built.protectedHeader.ciphertext.slice(0,-2)},identity)).toThrow();
 expect(()=>openSnapshotIndexItem(built.items[1]!.protectedItem,header,'records',0)).toThrow();
 expect(()=>openSnapshotIndexItem(stored.protectedItem,{...header},'records',0)).toThrow();
 expect(()=>openSnapshotIndexChunk(built.items[1]!.chunks[0]!,item,0)).toThrow();
 expect(()=>openSnapshotIndexChunk(stored.chunks[0]!,{...item},0)).toThrow();
 expect(()=>openSnapshotIndexChunk(stored.chunks[0]!,item,1)).toThrow();
 expect(()=>openSnapshotIndexChunk({...stored.chunks[0]!,authentication:'0'.repeat(64)},item,0)).toThrow();
});
it('derives source permission requirements and refuses missing original bytes',async()=>{
 const value=input();
 await expect(buildSnapshotIndex(value.sealed,value.artifacts,[])).rejects.toThrow(/permission/i);
 await expect(buildSnapshotIndex(value.sealed,[],['read:reports'])).rejects.toThrow(/artifact/i);
});
it('rejects caller getters without invoking them and responds to a real timer abort',async()=>{
 const value=input(2000);let calls=0;
 await expect(buildSnapshotIndex({...value.sealed,get canonicalData(){calls++;return value.sealed.canonicalData;}},value.artifacts,['read:reports'])).rejects.toThrow();
 expect(calls).toBe(0);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),0);
 try{await expect(buildSnapshotIndex(value.sealed,value.artifacts,['read:reports'],{signal:controller.signal})).rejects.toThrow(/abort/i);}finally{clearTimeout(timer);}
});
it('requires payroll authority derived from complete signed populations, including empty ones',async()=>{
 const value=input(),data={...value.data,populations:[...value.data.populations,
  {source:'payroll_run',count:0,excludedCount:0,exclusions:[]},{source:'payroll_run_line',count:0,excludedCount:0,exclusions:[]}]};
 const sealed=sealAuditSnapshot(data);
 await expect(buildSnapshotIndex(sealed,value.artifacts,['read:reports'])).rejects.toThrow(/permissions/);
 const built=await buildSnapshotIndex(sealed,value.artifacts,['read:reports','read:payroll']);
 expect(openSnapshotIndexHeader(built.protectedHeader,identity).permissions).toEqual(['read:payroll','read:reports']);
 await expect(buildSnapshotIndex(sealAuditSnapshot({...data,populations:data.populations.slice(0,-1)}),value.artifacts,['read:reports','read:payroll'])).rejects.toThrow(/population/);
});
it('binds key IDs and external signature independently of the encrypted envelope',async()=>{
 const value=input(),built=await buildSnapshotIndex(value.sealed,value.artifacts,['read:reports']);
 vi.stubEnv('CONTROL_SNAPSHOT_KEY_ID','rotated');expect(()=>openSnapshotIndexHeader(built.protectedHeader,identity)).toThrow();
 vi.stubEnv('CONTROL_SNAPSHOT_KEY_ID','current');vi.stubEnv('CONTROL_ENCRYPTION_KEY_ID','rotated');expect(()=>openSnapshotIndexHeader(built.protectedHeader,identity)).toThrow();
 vi.stubEnv('CONTROL_ENCRYPTION_KEY_ID','current');vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','another-synthetic-signing-key-00000000001');
 expect(()=>openSnapshotIndexHeader(built.protectedHeader,identity)).toThrow();
});
it('rejects oversized envelope values and accessor options without invoking caller code',async()=>{
 const value=input(),built=await buildSnapshotIndex(value.sealed,value.artifacts,['read:reports']);let calls=0;
 expect(()=>openSnapshotIndexHeader({...built.protectedHeader,ciphertext:'0'.repeat(800001)},identity)).toThrow();
 await expect(buildSnapshotIndex(value.sealed,value.artifacts,['read:reports'],{get deadlineAt(){calls++;return Date.now()+1000;}})).rejects.toThrow();
 expect(()=>openSnapshotIndexHeader({...built.protectedHeader,get authentication(){calls++;return built.protectedHeader.authentication;}},identity)).toThrow();
 expect(calls).toBe(0);
});
