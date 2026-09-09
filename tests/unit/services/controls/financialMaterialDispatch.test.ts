import {beforeEach,expect,it,vi} from 'vitest';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
const mocks=vi.hoisted(()=>({bank:vi.fn(),asset:vi.fn(),ar:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/bankTransferOperationMaterializer',()=>({materializeBankTransferOperation:mocks.bank}));
vi.mock('@/modules/accounting/services/controls/assetDepreciationOperationMaterializer',()=>({materializeAssetDepreciationOperation:mocks.asset}));
vi.mock('@/modules/accounting/services/controls/arOperationMaterializer',()=>({materializeArOperation:mocks.ar}));
import {canonicalOperationRef,materializeOperation} from '@/modules/accounting/services/controls/operationMaterializer';
beforeEach(()=>vi.clearAllMocks());
it.each([
 ['bank_transfer_intent','bank_transfer.post','bank'],['asset_depreciation_intent','asset_depreciation.post','asset'],
 ['customer_invoice','customer_invoice.post','ar'],['customer_invoice','customer_invoice.cancel','ar'],
 ['customer_payment','customer_payment.confirm','ar'],['customer_payment','customer_payment.cancel','ar'],
 ['credit_note','credit_note.approve','ar'],['credit_note','credit_note.cancel','ar'],
 ['credit_note_application','credit_note_application.apply','ar'],['recurring_invoice_run','recurring_invoice.generate','ar'],
] as const)('routes %s %s to its authoritative material',async(entityType,operation,target)=>{
 const ref:OperationRef={entityType,operation,entityId:'11111111-1111-4111-8111-111111111111'};
 expect(canonicalOperationRef(ref)).toEqual(ref);
 mocks[target].mockResolvedValue({binding:{amount:'115.1',currency:'ZAR'}});
 const ctx={} as ControlTx;expect(await materializeOperation(ctx,ref)).toEqual({binding:{amount:'115.1',currency:'ZAR'}});
 expect(mocks[target]).toHaveBeenCalledWith(ctx,ref);
});
it.each(['customer_invoice','customer_payment','credit_note'])('recovers the frozen reversal date for %s',entityType=>{
 const ref={entityType,entityId:'11111111-1111-4111-8111-111111111111',operation:`${entityType}.cancel`,accountingDate:'2026-09-09'};
 expect(canonicalOperationRef(ref as OperationRef).reversalDate).toBe('2026-09-09');
});
