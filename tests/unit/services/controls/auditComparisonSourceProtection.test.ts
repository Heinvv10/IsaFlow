import {afterEach,expect,it,vi} from 'vitest';
import {sealComparisonSource,openComparisonSourceHeader,openComparisonSourceItem} from '@/modules/accounting/services/controls/auditComparisonSourceProtection';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
const companyId='11111111-1111-4111-8111-111111111111',snapshotId='22222222-2222-4222-8222-222222222222';
afterEach(()=>vi.unstubAllEnvs());
function source(){
 vi.stubEnv('ENCRYPTION_KEY','synthetic-comparison-encryption-key-0000000000');
 vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-comparison-signing-key-000000000000');
 return sealAuditSnapshot({version:1,companyId,snapshotId,cutoff:'2026-09-09',capturedAt:'2026-09-10T00:00:00.000Z',
  records:[{source:'journal_entry',id:'z',version:1,data:{description:'private-original'}},{source:'journal_line',id:'a',version:1,data:{}}],
  populations:[{source:'journal_entry',count:1,excludedCount:0,exclusions:[]},{source:'journal_line',count:1,excludedCount:0,exclusions:[]}],
  checks:[],evidence:[],evidenceGaps:[],coverage:[],missingSources:[]});
}
it('retains authenticated sorted positions and original ordinals without exposing original material',async()=>{
 const sealed=source(),expected={companyId,snapshotId,canonicalHash:sealed.canonicalHash};
 const stored=await sealComparisonSource(sealed,{companyId,snapshotId},['read:reports']);
 const header=openComparisonSourceHeader(stored.protectedHeader,expected);
 expect(header.counts.records).toBe(2);expect(Object.isFrozen(header.counts)).toBe(true);
 const first=openComparisonSourceItem(stored.items[0]!.protectedItem,header,'records',0);
 expect(first.ordinal).toBe(1);expect(first.identity).toEqual({source:'journal_line',id:'a'});
 expect(JSON.stringify(stored)).not.toContain('private-original');expect(Object.isFrozen(first.identity)).toBe(true);
});
it('refuses swapped tenant, snapshot, hash, domain, position and unverified header',async()=>{
 const sealed=source(),expected={companyId,snapshotId,canonicalHash:sealed.canonicalHash};
 const stored=await sealComparisonSource(sealed,{companyId,snapshotId},['read:reports']);
 const header=openComparisonSourceHeader(stored.protectedHeader,expected),item=stored.items[0]!.protectedItem;
 for(const wrong of [{...expected,companyId:snapshotId},{...expected,snapshotId:companyId},{...expected,canonicalHash:'a'.repeat(64)}])expect(()=>openComparisonSourceHeader(stored.protectedHeader,wrong)).toThrow();
 expect(()=>openComparisonSourceHeader(item,expected)).toThrow();
 expect(()=>openComparisonSourceItem(stored.protectedHeader,header,'records',0)).toThrow();
 expect(()=>openComparisonSourceItem(item,header,'records',1)).toThrow();
 expect(()=>openComparisonSourceItem(item,header,'checks',0)).toThrow();
 expect(()=>openComparisonSourceItem(item,{...header},'records',0)).toThrow();
 expect(()=>openComparisonSourceItem({...item,authentication:'0'.repeat(64)},header,'records',0)).toThrow();
});
it('requires an authenticated original seal before creating signed source projections',async()=>{
 const sealed=source();
 await expect(sealComparisonSource({...sealed,authentication:'0'.repeat(64)},{companyId,snapshotId},['read:reports'])).rejects.toThrow();
 await expect(sealComparisonSource(sealed,{companyId,snapshotId},['read:payroll'])).rejects.toThrow();
});
