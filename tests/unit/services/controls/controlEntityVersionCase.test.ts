import {expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:()=>undefined}));
import {readControlEntityVersion,retainedLineage} from '@/modules/accounting/services/controls/operationVersions';
// The rule: follow the most advanced lineage (highest version), canonical spelling on a tie, and refuse a tie with no
// canonical spelling. The SQL only has to hand over the two leading candidates; which one wins is decided here.
const id='abcdefab-cdef-4abc-8def-abcdefabcdef',UPPER=id.toUpperCase(),MIXED=`${id.slice(0,8).toUpperCase()}${id.slice(8)}`;
const hash=(n:string)=>n.repeat(64);
const ctxWith=(rows:unknown[])=>({principal:{companyId:'00000000-0000-4000-8000-000000000001'},sql:vi.fn(async()=>rows)} as unknown as ControlTx);
it('returns the single retained lineage whatever its spelling',async()=>{
 await expect(readControlEntityVersion(ctxWith([{entity_id:UPPER,version:2,material_hash:hash('a')}]),{entityType:'bank_allocation_intent',entityId:id}))
  .resolves.toEqual({version:2,materialHash:hash('a')});
});
it('follows the most advanced lineage even when the canonical spelling is retained',()=>{
 expect(retainedLineage([{entity_id:id,version:1},{entity_id:UPPER,version:7}],id)).toEqual({entity_id:UPPER,version:7});
 expect(retainedLineage([{entity_id:UPPER,version:'7'},{entity_id:id,version:'1'}],UPPER)).toEqual({entity_id:UPPER,version:'7'});
});
it('breaks a tie at the highest version toward the canonical spelling, whatever the caller spelled',()=>{
 expect(retainedLineage([{entity_id:UPPER,version:3},{entity_id:id,version:3}],UPPER)).toEqual({entity_id:id,version:3});
});
it('refuses a tie at the highest version when neither spelling is canonical',async()=>{
 expect(()=>retainedLineage([{entity_id:UPPER,version:3},{entity_id:MIXED,version:3}],id)).toThrow('Ambiguous control entity version');
 await expect(readControlEntityVersion(ctxWith([{entity_id:UPPER,version:2,material_hash:hash('a')},{entity_id:MIXED,version:2,material_hash:hash('b')}]),
  {entityType:'bank_allocation_intent',entityId:id})).rejects.toThrow('Ambiguous control entity version');
});
it('still reports untracked history as null',async()=>{
 await expect(readControlEntityVersion(ctxWith([]),{entityType:'bank_allocation_intent',entityId:id})).resolves.toBeNull();
});
