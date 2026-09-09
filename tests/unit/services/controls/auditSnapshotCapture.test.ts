import {expect,it} from 'vitest';
import {captureAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotCapture';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('refuses an unissued transaction before reading any source material',async()=>{
 await expect(captureAuditSnapshot({} as ControlTx,{snapshotId:'00000000-0000-4000-8000-000000000001',
  request:{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:'unit'}})).rejects.toThrow(/context|transaction/i);
});
