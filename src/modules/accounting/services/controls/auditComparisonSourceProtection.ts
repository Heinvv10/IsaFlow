import {z} from 'zod';
import {setImmediate} from 'node:timers/promises';
import {canonicalJson} from './canonical';
import {createComparisonProjection} from './auditComparisonProjectionMaterial';
import {indexCryptography} from './auditSnapshotIndexCrypto';
import {indexBudget} from './auditSnapshotIndexValidation';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
import type {SealedAuditSnapshot} from './auditSnapshotSeal';
import {COMPARISON_SECTIONS,type ComparisonSection,type ComparisonItem,type ComparisonOptions} from './auditSnapshotComparisonMaterial';
const hash=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().min(1).max(256);
const identity=z.object({companyId:z.string().uuid(),snapshotId:z.string().uuid(),canonicalHash:hash}).strict();
const count=z.number().int().min(0).max(100000);
const headerSchema=identity.extend({version:z.literal(1),cutoff:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),capturedAt:z.string().datetime(),
 populationsHash:hash,coverageHash:hash,
 permissions:z.array(z.enum(['read:reports','read:invoices','read:bank-tx','read:payroll'])).min(1).max(4)
  .refine(values=>values.includes('read:reports')&&new Set(values).size===values.length&&canonicalJson(values)===canonicalJson([...values].sort())),
 counts:z.object({records:count,checks:z.number().int().min(0).max(6),evidence:count,evidenceGaps:count}).strict(),
}).strict().refine(value=>value.counts.evidence+value.counts.evidenceGaps<=100000);
const itemSchema=identity.extend({version:z.literal(1),section:z.enum(COMPARISON_SECTIONS),position:z.number().int().min(0).max(99999),
 item:z.object({identity:z.union([z.object({source:text,id:text}).strict(),z.object({checkId:text}).strict(),z.object({id:text}).strict()]),
  materialHash:hash,ordinal:z.number().int().min(0).max(99999)}).strict(),
}).strict();
export type ComparisonSourceHeader=z.infer<typeof headerSchema>;
const openedHeaders=new WeakSet<ComparisonSourceHeader>();
const same=(a:z.infer<typeof identity>,b:z.infer<typeof identity>)=>a.companyId===b.companyId&&a.snapshotId===b.snapshotId&&a.canonicalHash===b.canonicalHash;
/** Signing is reachable only after authenticating the original seal and its source permission set. */
export async function sealComparisonSource(sealed:SealedAuditSnapshot,expected:{companyId:string;snapshotId:string},permissions:string[],options?:ComparisonOptions){
 const check=indexBudget(options),projection=await createComparisonProjection(sealed,expected,permissions,options);check();
 const {sections,...metadata}=projection,header=headerSchema.parse(metadata),crypto=indexCryptography();
 const source={companyId:header.companyId,snapshotId:header.snapshotId,canonicalHash:header.canonicalHash};
 const items:Array<{section:ComparisonSection;position:number;protectedItem:SnapshotIndexEnvelope}>=[];
 for(const section of COMPARISON_SECTIONS)for(let position=0;position<sections[section].length;position++){
  check();const value=itemSchema.parse({...source,version:1,section,position,item:sections[section][position]});
  items.push({section,position,protectedItem:crypto.seal('comparison-source-item',value)});
  if(items.length%64===0){await setImmediate();check();}
 }
 check();return{protectedHeader:crypto.seal('comparison-source-header',header),items};
}
/** Opening an envelope establishes integrity, not current read authority; services must check current permissions. */
export function openComparisonSourceHeader(envelope:SnapshotIndexEnvelope,expected:z.infer<typeof identity>):ComparisonSourceHeader{
 const bound=identity.parse(JSON.parse(canonicalJson(expected)));
 const header=headerSchema.parse(indexCryptography().open('comparison-source-header',envelope));
 if(!same(header,bound))throw new Error('Comparison source header identity changed');
 Object.freeze(header.permissions);Object.freeze(header.counts);Object.freeze(header);openedHeaders.add(header);return header;
}
export function openComparisonSourceItem(envelope:SnapshotIndexEnvelope,header:ComparisonSourceHeader,section:ComparisonSection,position:number):ComparisonItem{
 if(!openedHeaders.has(header)||!COMPARISON_SECTIONS.includes(section)||!Number.isSafeInteger(position)||position<0||position>=header.counts[section])throw new Error('Verified comparison header and position required');
 const value=itemSchema.parse(indexCryptography().open('comparison-source-item',envelope));
 if(!same(value,header)||value.section!==section||value.position!==position||value.item.ordinal>=header.counts[section])throw new Error('Comparison source item identity changed');
 const keys=Object.keys(value.item.identity).sort().join(',');
 if(keys!==(section==='records'?'id,source':section==='checks'?'checkId':'id'))throw new Error('Comparison source identity family changed');
 Object.freeze(value.item.identity);Object.freeze(value.item);return value.item;
}
