import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {verifyInvoiceMatchEvidence} from '@/modules/accounting/services/ap/invoiceMatchOverrideMaterial';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import type {EvidenceRef} from '@/modules/accounting/services/controls/contracts';
import {loadOwnedCapturedEvidence} from '@/modules/accounting/services/controls/capturedEvidenceSource';
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:vi.fn().mockResolvedValue(undefined)}));
vi.mock('@/modules/accounting/services/controls/capturedEvidenceSource',()=>({loadOwnedCapturedEvidence:vi.fn()}));
const companyId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const hash='a'.repeat(64),query=vi.fn(),client={query} as unknown as PoolClient;
const ref:EvidenceRef={store:'captured',evidenceId:id,entityType:'supplier_invoice',entityId:id,version:null,hash};
const check=(refs:EvidenceRef[])=>withControlRequest({client,userId:'u1',companyId,claims:{}},
 {personId:'u1',companyId,authMethod:'cookie'},()=>verifyInvoiceMatchEvidence(requireControlTx(),id,refs));
beforeEach(()=>{query.mockReset().mockResolvedValue({rows:[{id}]});vi.mocked(loadOwnedCapturedEvidence).mockReset().mockResolvedValue(
 {id,status:'matched',bytes:Buffer.from('evidence'),sha256:hash,recordedHashVerified:true,mediaType:'application/pdf'});});
afterEach(()=>vi.restoreAllMocks());
it('reads actual captured bytes after owned invoice association',async()=>{
 expect(await check([ref])).toEqual([ref]);expect(loadOwnedCapturedEvidence).toHaveBeenCalledWith(expect.anything(),id,'read:invoices',expect.any(AbortSignal));
 expect(query.mock.calls[0]![0]).toContain('i.company_id=d.company_id');
 query.mockResolvedValue({rows:[]});vi.mocked(loadOwnedCapturedEvidence).mockClear();
 await expect(check([ref])).rejects.toThrow();expect(loadOwnedCapturedEvidence).not.toHaveBeenCalled();
});
it('rejects missing or unauthenticated bytes despite a matching association',async()=>{
 vi.mocked(loadOwnedCapturedEvidence).mockResolvedValue(null);await expect(check([ref])).rejects.toThrow();
 vi.mocked(loadOwnedCapturedEvidence).mockResolvedValue({id,status:'matched',bytes:Buffer.from('evidence'),sha256:hash,recordedHashVerified:false,mediaType:'application/pdf'});
 await expect(check([ref])).rejects.toThrow();
});
it('detaches evidence before the first await and rejects accessors without executing them',async()=>{
 const supplied={...ref};query.mockImplementation(async()=>{supplied.hash='b'.repeat(64);return{rows:[{id}]};});
 expect(await check([supplied])).toEqual([ref]);
 let calls=0;Object.defineProperty(supplied,'hash',{enumerable:true,get(){calls++;return hash;}});
 await expect(check([supplied])).rejects.toThrow();expect(calls).toBe(0);
});
it('preserves authority or SQL failures after the shared deadline',async()=>{
 const controller=new AbortController();vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal);
 const failure=new Error('Current authority denied');vi.mocked(loadOwnedCapturedEvidence).mockImplementation(async()=>{controller.abort();throw failure;});
 await expect(check([ref])).rejects.toBe(failure);
});
it('uses one cancellation signal for the complete batch',async()=>{
 const second={...ref,evidenceId:'33333333-3333-4333-8333-333333333333'};
 await check([ref,second]);
 expect(vi.mocked(loadOwnedCapturedEvidence).mock.calls).toHaveLength(2);
 expect(vi.mocked(loadOwnedCapturedEvidence).mock.calls[0]![3]).toBe(vi.mocked(loadOwnedCapturedEvidence).mock.calls[1]![3]);
});
it('rejects invalid later references before any evidence IO',async()=>{
 await expect(check([ref,{...ref,entityId:companyId}])).rejects.toThrow();
 expect(query).not.toHaveBeenCalled();expect(loadOwnedCapturedEvidence).not.toHaveBeenCalled();
});
