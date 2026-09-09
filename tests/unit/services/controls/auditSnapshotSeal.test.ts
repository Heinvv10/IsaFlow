import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {sealAuditSnapshot,verifyAuditSnapshot,verifySnapshotArtifact} from '@/modules/accounting/services/controls/auditSnapshotSeal';
const companyId='00000000-0000-4000-8000-000000000001';
const snapshotId='00000000-0000-4000-8000-000000000002';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function capture(){
 return {version:1 as const,companyId,snapshotId,cutoff:'2026-09-09',capturedAt:'2026-09-10T01:00:00.000Z',
  records:[{source:'journals',id:'j2',version:2,data:{amount:'115.00',accountingDate:'2026-09-08'}},
   {source:'journals',id:'j1',version:null,data:{amount:'20.00',accountingDate:'2026-09-09'}}],
  populations:[{source:'journals',count:2,excludedCount:0,exclusions:[]}],
  checks:[],evidence:[{id:'original-statement',sha256:sha('original bytes'),byteLength:14,mediaType:'text/csv'}],
  coverage:['external_confirmation_not_performed'],missingSources:[]};
}
afterEach(()=>vi.unstubAllEnvs());
function key(){vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-only-snapshot-key-0000000000000000000001');}
it('seals the complete retained population independent of record order and object key order',()=>{
 key();const input=capture(),sealed=sealAuditSnapshot(input);
 expect(sealAuditSnapshot({...input,records:[...input.records].reverse()})).toEqual(sealed);
 expect(verifyAuditSnapshot(sealed,{companyId,snapshotId}).records).toHaveLength(2);
 input.records[0]!.data.amount='999';
 expect(verifyAuditSnapshot(sealed,{companyId,snapshotId}).records[1]!.data.amount).toBe('115.00');
});
it('detects database replacement even when the attacker recomputes the ordinary hash',()=>{
 key();const sealed=sealAuditSnapshot(capture());
 const changed=JSON.parse(sealed.canonicalData);changed.records[0].data.amount='999.00';
 const canonicalData=JSON.stringify(changed);
 expect(()=>verifyAuditSnapshot({...sealed,canonicalData,canonicalHash:sha(canonicalData)},{companyId,snapshotId})).toThrow();
 expect(()=>verifyAuditSnapshot(sealed,{companyId:'00000000-0000-4000-8000-000000000003',snapshotId})).toThrow();
 expect(()=>verifyAuditSnapshot(sealed,{companyId,snapshotId:companyId})).toThrow();
});
it('authenticates retained source bytes and keeps separately rendered PDF bytes outside canonical identity',()=>{
 key();const sealed=sealAuditSnapshot(capture()),snapshot=verifyAuditSnapshot(sealed,{companyId,snapshotId});
 expect(()=>verifySnapshotArtifact(snapshot,'original-statement',Buffer.from('original bytes'))).not.toThrow();
 expect(()=>verifySnapshotArtifact(snapshot,'original-statement',Buffer.from('replaced bytes'))).toThrow();
 expect(()=>verifySnapshotArtifact(snapshot,'missing',Buffer.from('original bytes'))).toThrow();
 expect(()=>sealAuditSnapshot({...capture(),renderedPdf:Buffer.from('pdf')})).toThrow();
 expect(sealAuditSnapshot(capture()).canonicalHash).toBe(sealed.canonicalHash);
});
it('refuses duplicate identities, incomplete populations, invalid cutoff and missing independent key',()=>{
 key();const input=capture();
 for(const changed of [
  {records:[input.records[0],input.records[0]]},
  {populations:[{...input.populations[0],count:3}]},
  {populations:[]},{cutoff:'2026-02-30'},
  {evidence:[input.evidence[0],input.evidence[0]]},
 ])expect(()=>sealAuditSnapshot({...input,...changed})).toThrow();
 vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','');expect(()=>sealAuditSnapshot(input)).toThrow(/key/i);
});
it('requires verified immutable material when checking retained artifact bytes',()=>{
 key();const original=capture();
 expect(()=>verifySnapshotArtifact(original,'original-statement',Buffer.from('original bytes'))).toThrow(/verified/i);
 const verified=verifyAuditSnapshot(sealAuditSnapshot(original),{companyId,snapshotId});
 expect(()=>verifySnapshotArtifact({...verified},'original-statement',Buffer.from('original bytes'))).toThrow(/verified/i);
 expect(()=>{verified.evidence[0]!.sha256=sha('replaced bytes');}).toThrow();
 expect(()=>{verified.records[0]!.data.amount='900';}).toThrow();
});
it('refuses accessor envelopes before authentication can verify different bytes from parsing',()=>{
 key();const sealed=sealAuditSnapshot(capture()),changed=JSON.parse(sealed.canonicalData);
 changed.records[0].data.amount='999.00';const unsigned=JSON.stringify(changed);let reads=0;
 const envelope={...sealed,get canonicalData(){return ++reads<=3?sealed.canonicalData:unsigned;}};
 expect(()=>verifyAuditSnapshot(envelope,{companyId,snapshotId})).toThrow();
 expect(reads).toBe(0);
});
it('rejects accessor-bearing expected identities without invoking caller code',()=>{
 key();const sealed=sealAuditSnapshot(capture());let reads=0;
 expect(()=>verifyAuditSnapshot(sealed,{get companyId(){reads++;return companyId;},snapshotId})).toThrow();
 expect(reads).toBe(0);
});
