import {createHash} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {retainSnapshotEvidence} from '@/modules/accounting/services/controls/auditSnapshotEvidence';
import {discoverSnapshotEvidence} from '@/modules/accounting/services/controls/auditSnapshotEvidenceQueries';
import {CapturedEvidenceUnavailableError,loadOwnedCapturedEvidence} from '@/modules/accounting/services/controls/capturedEvidenceSource';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import type {AuditSnapshotData} from '@/modules/accounting/services/controls/auditSnapshotSeal';
vi.mock('@/modules/accounting/services/controls/auditSnapshotEvidenceQueries',()=>({discoverSnapshotEvidence:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/capturedEvidenceSource',async original=>({...await original<typeof import('@/modules/accounting/services/controls/capturedEvidenceSource')>(),loadOwnedCapturedEvidence:vi.fn()}));
const companyId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const bytes=Buffer.from('Actual retained bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
const query=vi.fn(),client={query} as unknown as PoolClient;
const request={cutoff:'2026-09-09',sources:['journals'] as ['journals'],checks:[],idempotencyKey:'synthetic'};
const snapshot=():AuditSnapshotData=>({version:1,companyId,snapshotId:id,cutoff:request.cutoff,capturedAt:'2026-09-09T00:00:00.000Z',
 records:[{source:'journal_entry',id,version:null,data:{}}],populations:[{source:'journal_entry',count:1,excludedCount:0,exclusions:[]},{source:'journal_line',count:0,excludedCount:0,exclusions:[]}],
 checks:[],evidence:[],coverage:[],missingSources:['retained_evidence_not_attached']});
const relation={store:'captured' as const,documentId:id,parentSource:'journal_entry',parentId:id,relation:'source_document'};
const run=(input=snapshot())=>withControlRequest({client,userId:'u1',companyId,claims:{}},{personId:'u1',companyId,authMethod:'cookie'},()=>retainSnapshotEvidence(requireControlTx(),input,request));
beforeEach(()=>{
 query.mockReset().mockResolvedValue({rows:[{timeout:'0',isolation:'repeatable read'}]});
 vi.mocked(discoverSnapshotEvidence).mockReset().mockResolvedValue({relationCount:1,relations:[relation],nextCursor:null});
 vi.mocked(loadOwnedCapturedEvidence).mockReset().mockResolvedValue({id,status:'matched',bytes,sha256,recordedHashVerified:true,mediaType:'application/pdf'});
});
it('retains exact bytes once with all parent relations across discovery pages',async()=>{
 const second={...relation,relation:'matched_source'};
 vi.mocked(discoverSnapshotEvidence).mockResolvedValueOnce({relationCount:2,relations:[relation],nextCursor:'next'})
  .mockResolvedValueOnce({relationCount:2,relations:[second],nextCursor:null});
 const result=await run();
 expect(result.artifacts).toHaveLength(1);expect(Buffer.from(result.artifacts[0]!.bytes)).toEqual(bytes);
 expect(result.snapshot.evidence[0]).toMatchObject({id:`captured:${id}`,sha256,relations:expect.arrayContaining([
  {parentSource:'journal_entry',parentId:id,relation:'source_document'}, {parentSource:'journal_entry',parentId:id,relation:'matched_source'}])});
 expect(result.snapshot.missingSources).not.toContain('retained_evidence_not_attached');
 expect(loadOwnedCapturedEvidence).toHaveBeenCalledTimes(1);
});
it('retains missing source identity and parents without fabricated bytes or hash',async()=>{
 vi.mocked(loadOwnedCapturedEvidence).mockResolvedValue(null);const result=await run();
 expect(result.artifacts).toEqual([]);expect(result.snapshot.evidence).toEqual([]);
 expect(result.snapshot.evidenceGaps).toEqual([{id:`captured:${id}`,reason:'source_bytes_unavailable',relations:[{parentSource:'journal_entry',parentId:id,relation:'source_document'}]}]);
 expect(result.snapshot.missingSources).toContain('retained_source_bytes_unavailable');
});
it('propagates current authority failures instead of returning a partial capture',async()=>{
 const failure=new Error('Current authority revoked');vi.mocked(loadOwnedCapturedEvidence).mockRejectedValue(failure);
 await expect(run()).rejects.toBe(failure);
});
it('refuses incomplete relation pagination before retaining any bytes',async()=>{
 vi.mocked(discoverSnapshotEvidence).mockResolvedValue({relationCount:2,relations:[relation],nextCursor:null});
 await expect(run()).rejects.toThrow(/population/i);expect(loadOwnedCapturedEvidence).not.toHaveBeenCalled();
});

it('does not widen a shorter caller SQL statement timeout while retaining evidence',async()=>{
 query.mockResolvedValue({rows:[{timeout:'50ms',timeout_ms:'50',isolation:'repeatable read'}]});
 await run();
 const changes=query.mock.calls.filter(call=>String(call[0]).includes("set_config('statement_timeout'"));
 expect(changes.length).toBeGreaterThan(1);
 for(const call of changes)expect(Number.parseInt(call[1][0],10)).toBeLessThanOrEqual(50);
});

it('refuses storage integrity and resource failures rather than publishing a partial snapshot',async()=>{
 const failure=new CapturedEvidenceUnavailableError(new Error('Captured evidence byte resource limit'));
 vi.mocked(loadOwnedCapturedEvidence).mockRejectedValue(failure);
 await expect(run()).rejects.toBe(failure);
});
