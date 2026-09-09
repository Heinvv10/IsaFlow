import {expect,it,vi} from 'vitest';
import {loadEvidenceNode} from '@/modules/accounting/services/controls/transactionEvidenceQueries';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('recognizes real posted originals marked reversed by the shared GL writer',async()=>{
 const sql=vi.fn().mockResolvedValueOnce([{id:'11111111-1111-4111-8111-111111111111',status:'posted',reversed:true}]).mockResolvedValueOnce([]);
 const ctx={sql,principal:{companyId:'22222222-2222-4222-8222-222222222222'}} as unknown as ControlTx;
 const node=await loadEvidenceNode(ctx,{entityType:'journal_entry',entityId:'11111111-1111-4111-8111-111111111111'},new Set(['read:reports']));
 expect(node?.status).toBe('posted');expect(node?.flags).toContain('reversed');
 expect(sql.mock.calls[0]![0].join('')).toContain('reversed_at');
});
it('refuses legacy procurement invoice evidence for a native invoice approval before any ambiguous ownership SQL',async()=>{
 const {validateApprovalEvidence}=await import('@/modules/accounting/services/controls/approvalQueries');
 const sql=vi.fn().mockResolvedValue([{id:'document'}]);
 const ctx={sql,principal:{companyId:'22222222-2222-4222-8222-222222222222'}} as unknown as ControlTx;
 const ref={store:'procurement' as const,evidenceId:'11111111-1111-4111-8111-111111111111',entityType:'supplier_invoice',entityId:'33333333-3333-4333-8333-333333333333',version:null,hash:null};
 await expect(validateApprovalEvidence(ctx,{entityType:ref.entityType,entityId:ref.entityId} as never,[ref])).rejects.toThrow('Unsupported');
 expect(sql).not.toHaveBeenCalled();
});
it('does not invent a reversal for a cancelled invoice',async()=>{
 const sql=vi.fn().mockResolvedValueOnce([{id:'11111111-1111-4111-8111-111111111111',status:'cancelled',reversed:false}]).mockResolvedValueOnce([]);
 const ctx={sql,principal:{companyId:'22222222-2222-4222-8222-222222222222'}} as unknown as ControlTx;
 expect((await loadEvidenceNode(ctx,{entityType:'supplier_invoice',entityId:'11111111-1111-4111-8111-111111111111'},new Set(['read:invoices'])))?.flags).not.toContain('reversed');
});
it.each([['customer_payment','confirmed'],['credit_note','applied']] as const)('retains the safe persisted %s lifecycle state',async(entityType,status)=>{
 const sql=vi.fn().mockResolvedValueOnce([{id:'11111111-1111-4111-8111-111111111111',status,reversed:false}]).mockResolvedValueOnce([]);
 const ctx={sql,principal:{companyId:'22222222-2222-4222-8222-222222222222'}} as unknown as ControlTx;
 const node=await loadEvidenceNode(ctx,{entityType,entityId:'11111111-1111-4111-8111-111111111111'},new Set(['read:invoices']));
 expect(node?.status).toBe(status);
});
