import {z} from 'zod';
import {canonicalJson} from './canonical';
import {indexCryptography} from './auditSnapshotIndexCrypto';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
import {COMPARISON_SECTIONS,type ComparisonSection} from './auditSnapshotComparisonMaterial';
const hash=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().min(1).max(256);
const identitySchema=z.object({companyId:z.string().uuid(),comparisonId:z.string().uuid(),generation:z.number().int().positive(),leaseId:z.string().uuid()}).strict();
const source=z.object({id:z.string().uuid(),canonicalHash:hash,cutoff:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),capturedAt:z.string().datetime()}).strict();
const count=z.number().int().min(0).max(100000);
const counts=z.object({first:count,second:count,added:count,removed:count,changed:count,unchanged:count}).strict()
 .refine(row=>row.first===row.removed+row.changed+row.unchanged&&row.second===row.added+row.changed+row.unchanged);
const headerSchema=identitySchema.extend({version:z.literal(1),comparisonRuleVersion:z.literal(1),first:source,second:source,
 permissions:z.array(z.enum(['read:reports','read:invoices','read:bank-tx','read:payroll'])).min(1).max(4)
  .refine(values=>values.includes('read:reports')&&new Set(values).size===values.length&&canonicalJson(values)===canonicalJson([...values].sort())),
 counts:z.object({records:counts,checks:counts,evidence:counts,evidenceGaps:counts}).strict(),
 populationChanged:z.boolean(),coverageChanged:z.boolean(),canonicalHash:hash,
}).strict().refine(row=>row.counts.checks.first<=6&&row.counts.checks.second<=6
 &&row.counts.evidence.first+row.counts.evidenceGaps.first<=100000&&row.counts.evidence.second+row.counts.evidenceGaps.second<=100000);
const reference=z.object({snapshotId:z.string().uuid(),canonicalHash:hash,ordinal:z.number().int().min(0).max(99999),materialHash:hash}).strict();
const change=z.object({section:z.enum(COMPARISON_SECTIONS),kind:z.enum(['added','removed','changed']),
 identity:z.union([z.object({source:text,id:text}).strict(),z.object({checkId:text}).strict(),z.object({id:text}).strict()]),before:reference.nullable(),after:reference.nullable(),
}).strict().refine(row=>row.kind==='added'?row.before===null&&row.after!==null:row.kind==='removed'?row.before!==null&&row.after===null:row.before!==null&&row.after!==null)
 .refine(row=>Object.keys(row.identity).sort().join(',')===(row.section==='records'?'id,source':row.section==='checks'?'checkId':'id'));
const itemSchema=identitySchema.extend({version:z.literal(1),position:z.number().int().min(0).max(200011),change}).strict();
export type ComparisonResultIdentity=z.infer<typeof identitySchema>;
export type ComparisonResultHeader=z.infer<typeof headerSchema>;
const headers=new WeakSet<ComparisonResultHeader>();
const detach=(value:unknown):unknown=>JSON.parse(canonicalJson(value));
const same=(a:ComparisonResultIdentity,b:ComparisonResultIdentity)=>a.companyId===b.companyId&&a.comparisonId===b.comparisonId&&a.generation===b.generation&&a.leaseId===b.leaseId;
function freeze(value:unknown):void{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
/** Internal publication primitives: callers derive material from verified streams and recheck current lease/authority. */
export function sealComparisonResultHeader(value:unknown):SnapshotIndexEnvelope{
 return indexCryptography().seal('comparison-result-header',headerSchema.parse(detach(value)));
}
/** Items may be staged before counts are final. The header and success pointer publish only after reconciliation. */
export function sealComparisonResultItem(identity:ComparisonResultIdentity,position:number,value:unknown):SnapshotIndexEnvelope{
 const bound=identitySchema.parse(detach(identity)),parsed=change.parse(detach(value));
 return indexCryptography().seal('comparison-result-item',itemSchema.parse({...bound,version:1,position,change:parsed}));
}
export function openComparisonResultHeader(envelope:SnapshotIndexEnvelope,expected:ComparisonResultIdentity):ComparisonResultHeader{
 const bound=identitySchema.parse(detach(expected)),header=headerSchema.parse(indexCryptography().open('comparison-result-header',envelope));
 if(!same(header,bound))throw new Error('Comparison result identity changed');
 freeze(header);headers.add(header);return header;
}
export function openComparisonResultItem(envelope:SnapshotIndexEnvelope,header:ComparisonResultHeader,section:ComparisonSection,position:number){
 if(!headers.has(header)||!COMPARISON_SECTIONS.includes(section)||!Number.isSafeInteger(position)||position<0)throw new Error('Verified result header and position required');
 const counts=header.counts[section];if(position>=counts.added+counts.removed+counts.changed)throw new Error('Comparison output position outside population');
 const row=itemSchema.parse(indexCryptography().open('comparison-result-item',envelope));
 if(!same(row,header)||row.position!==position||row.change.section!==section)throw new Error('Comparison result item identity changed');
 for(const side of ['before','after'] as const){
  const ref=row.change[side],source=side==='before'?header.first:header.second,max=side==='before'?counts.first:counts.second;
  if(ref&&(ref.snapshotId!==source.id||ref.canonicalHash!==source.canonicalHash||ref.ordinal>=max))throw new Error('Comparison original source reference changed');
 }
 freeze(row.change);return row.change;
}
