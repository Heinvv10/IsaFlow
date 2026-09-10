import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {createComparisonResultDigest} from '@/modules/accounting/services/controls/auditComparisonResultDigest';
import type {ComparisonResultHeader} from '@/modules/accounting/services/controls/auditComparisonResultProtection';
import type {ComparisonChange} from '@/modules/accounting/services/controls/auditSnapshotComparisonMaterial';
const zero={first:0,second:0,added:0,removed:0,changed:0,unchanged:0};
const source={id:'11111111-1111-4111-8111-111111111111',canonicalHash:'a'.repeat(64),cutoff:'2026-09-09',capturedAt:'2026-09-10T00:00:00.000Z'};
const header:ComparisonResultHeader={version:1,comparisonRuleVersion:1,companyId:source.id,comparisonId:source.id,generation:1,leaseId:source.id,
 first:source,second:{...source,id:'22222222-2222-4222-8222-222222222222'},permissions:['read:reports'],canonicalHash:'0'.repeat(64),
 counts:{records:{...zero,first:1,removed:1},checks:zero,evidence:zero,evidenceGaps:zero},populationChanged:false,coverageChanged:true};
const change:ComparisonChange={section:'records',kind:'removed',identity:{source:'journal_entry',id:'one'},before:{snapshotId:source.id,canonicalHash:source.canonicalHash,ordinal:0,materialHash:'b'.repeat(64)},after:null};
function compute(value=change,metadata=header){const digest=createComparisonResultDigest();digest.append(value);return digest.finish(metadata);}
it('matches the independent framed wire digest and ignores only execution identity and the digest field',()=>{
 const semantic={version:1,comparisonRuleVersion:1,companyId:header.companyId,first:header.first,second:header.second,
  permissions:header.permissions,counts:header.counts,populationChanged:false,coverageChanged:true};
 const expected=createHash('sha256').update('isaflow.audit-comparison-result.v1\n')
  .update(canonicalJson({section:'records',position:0,change})+'\n').update(canonicalJson(semantic)+'\n').digest('hex');
 expect(compute()).toBe(expected);
 expect(compute(change,{...header,comparisonId:header.second.id,generation:9,leaseId:header.second.id,canonicalHash:'f'.repeat(64)})).toBe(expected);
 expect(compute({...change,before:{...change.before!,materialHash:'c'.repeat(64)}})).not.toBe(expected);
 expect(compute(change,{...header,coverageChanged:false})).not.toBe(expected);
 expect(compute(change,{...header,companyId:header.second.id})).not.toBe(expected);
 expect(compute(change,{...header,first:header.second,second:header.first})).not.toBe(expected);
});
it('rejects missing, extra, duplicate and out-of-order output and cannot finalize or append twice',()=>{
 expect(()=>createComparisonResultDigest().finish(header)).toThrow(/count/i);
 const duplicate=createComparisonResultDigest();duplicate.append(change);expect(()=>duplicate.append(change)).toThrow(/order/i);
 const extra=createComparisonResultDigest();extra.append(change);extra.append({...change,identity:{source:'journal_entry',id:'two'}});
 expect(()=>extra.finish(header)).toThrow(/count/i);
 const order=createComparisonResultDigest();order.append({...change,section:'evidence',identity:{id:'x'}});expect(()=>order.append(change)).toThrow(/order/i);
 const done=createComparisonResultDigest();done.append(change);done.finish(header);
 expect(()=>done.finish(header)).toThrow(/final/i);expect(()=>done.append(change)).toThrow(/final/i);
});
it('reconciles per-kind counts rather than accepting an equal total with changed classification',()=>{
 const digest=createComparisonResultDigest();digest.append(change);
 expect(()=>digest.finish({...header,counts:{...header.counts,records:{...zero,second:1,added:1}}})).toThrow(/count/i);
});
