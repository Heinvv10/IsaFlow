import {expect,it} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';

it('rejects a copied lease and ordinary request before reading original retained material',async()=>{
 const {ensureOriginalSnapshotIndex}=await import('@/modules/accounting/services/controls/auditSnapshotIndexConversion');
 const ctx={principal:{companyId:'11111111-1111-4111-8111-111111111111',personId:'person',authMethod:'cookie'},sql:()=>{throw new Error('Unexpected source query');}} as unknown as ControlTx;
 const lease={companyId:ctx.principal.companyId,personId:'person',jobId:'22222222-2222-4222-8222-222222222222',leaseId:'33333333-3333-4333-8333-333333333333',generation:1} as AuditJobLease;
 await expect(ensureOriginalSnapshotIndex(ctx,lease,lease.jobId)).rejects.toThrow(/context|transaction|authority/i);
});
