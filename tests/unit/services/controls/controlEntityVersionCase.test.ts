import {expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:()=>undefined}));
import {readControlEntityVersion} from '@/modules/accounting/services/controls/operationVersions';
const id='abcdefab-cdef-4abc-8def-abcdefabcdef',hash='0'.repeat(64);
const ctxWith=(rows:unknown[])=>({principal:{companyId:'00000000-0000-4000-8000-000000000001'},sql:vi.fn(async()=>rows)} as unknown as ControlTx);
it('returns the single retained lineage whatever its spelling',async()=>{
 await expect(readControlEntityVersion(ctxWith([{entity_id:id.toUpperCase(),version:2,material_hash:hash}]),{entityType:'bank_allocation_intent',entityId:id}))
  .resolves.toEqual({version:2,materialHash:hash});
});
it('refuses two case-variant lineages instead of binding one of them',async()=>{
 await expect(readControlEntityVersion(ctxWith([{entity_id:id,version:1,material_hash:hash},{entity_id:id.toUpperCase(),version:2,material_hash:hash}]),
  {entityType:'bank_allocation_intent',entityId:id})).rejects.toThrow('Ambiguous control entity version');
});
it('still reports untracked history as null', async()=>{
 await expect(readControlEntityVersion(ctxWith([]),{entityType:'bank_allocation_intent',entityId:id})).resolves.toBeNull();
});
