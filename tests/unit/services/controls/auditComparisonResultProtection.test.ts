import {afterEach,expect,it,vi} from 'vitest';
import {sealComparisonResultHeader,openComparisonResultHeader,sealComparisonResultItem,openComparisonResultItem} from '@/modules/accounting/services/controls/auditComparisonResultProtection';
const companyId='11111111-1111-4111-8111-111111111111',comparisonId='22222222-2222-4222-8222-222222222222',leaseId='33333333-3333-4333-8333-333333333333';
const identity={companyId,comparisonId,generation:1,leaseId};
const meta={id:'44444444-4444-4444-8444-444444444444',canonicalHash:'a'.repeat(64),cutoff:'2026-09-09',capturedAt:'2026-09-10T00:00:00.000Z'};
const zero={first:0,second:0,added:0,removed:0,changed:0,unchanged:0};
const header={version:1,...identity,comparisonRuleVersion:1,permissions:['read:reports'],first:meta,second:{...meta,id:comparisonId},
 counts:{records:{...zero,first:1,removed:1},checks:zero,evidence:zero,evidenceGaps:zero},populationChanged:true,coverageChanged:false,canonicalHash:'b'.repeat(64)};
const change={section:'records' as const,kind:'removed' as const,identity:{source:'journal_entry',id:'retained'},before:{snapshotId:meta.id,canonicalHash:meta.canonicalHash,ordinal:0,materialHash:'c'.repeat(64)},after:null};
function keys(){vi.stubEnv('ENCRYPTION_KEY','synthetic-result-encryption-key-000000000000');vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-result-signing-key-00000000000000');}
afterEach(()=>vi.unstubAllEnvs());
it('opens exact generation-bound result references and refuses identity or domain substitutions',()=>{
 keys();const envelope=sealComparisonResultHeader(header),opened=openComparisonResultHeader(envelope,identity);
 const item=sealComparisonResultItem(identity,0,change);
 expect(openComparisonResultItem(item,opened,'records',0)).toEqual(change);
 expect(()=>openComparisonResultHeader(envelope,{...identity,generation:2})).toThrow();
 expect(()=>openComparisonResultHeader(envelope,{...identity,companyId:comparisonId})).toThrow();
 expect(()=>openComparisonResultHeader(item,identity)).toThrow();
 expect(()=>openComparisonResultItem(item,{...opened},'records',0)).toThrow();
 expect(()=>openComparisonResultItem(item,opened,'records',1)).toThrow();
 expect(Object.isFrozen(opened.counts.records)).toBe(true);
});
it('refuses incoherent counts, missing change sides and foreign source references',()=>{
 keys();expect(()=>sealComparisonResultHeader({...header,counts:{...header.counts,records:{...zero,first:1}}})).toThrow();
 expect(()=>sealComparisonResultItem(identity,0,{...change,kind:'changed'})).toThrow();
 const opened=openComparisonResultHeader(sealComparisonResultHeader(header),identity);
 const wrong=sealComparisonResultItem(identity,0,{...change,before:{...change.before,snapshotId:comparisonId}});
 expect(()=>openComparisonResultItem(wrong,opened,'records',0)).toThrow();
});
