import {z} from 'zod';
import {canonicalJson} from './canonical';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {readAuditSnapshotIndexHeader} from './auditSnapshotIndexRead';
import {openComparisonSourceHeader,openComparisonSourceItem,type ComparisonSourceHeader} from './auditComparisonSourceProtection';
import {indexBudget} from './auditSnapshotIndexValidation';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
import {COMPARISON_SECTIONS,type ComparisonSection,type ComparisonItem,type ComparisonOptions} from './auditSnapshotComparisonMaterial';
const issued=new WeakSet<ComparisonSourceHeader>();
async function assertOriginal(ctx:ControlTx,header:ComparisonSourceHeader){
 const original=await readAuditSnapshotIndexHeader(ctx,header.snapshotId);
 const counts={records:original.counts.records,checks:original.counts.checks,evidence:original.counts.evidence,evidenceGaps:original.counts.gaps};
 if(original.companyId!==header.companyId||original.canonicalHash!==header.canonicalHash
  ||canonicalJson(original.permissions)!==canonicalJson(header.permissions)||canonicalJson(counts)!==canonicalJson(header.counts))throw new Error('Comparison source differs from retained index');
}
/** Missing projections remain explicit. This read never performs legacy conversion or binary I/O. */
export async function readComparisonSourceHeader(ctx:ControlTx,snapshotId:string,expectedCanonicalHash:string):Promise<ComparisonSourceHeader>{
 assertControlTx(ctx);z.string().uuid().parse(snapshotId);z.string().regex(/^[a-f0-9]{64}$/).parse(expectedCanonicalHash);
 const original=await readAuditSnapshotIndexHeader(ctx,snapshotId);
 if(original.canonicalHash!==expectedCanonicalHash)throw new Error('Comparison expected source hash changed');
 const rows=await ctx.sql`SELECT protected_header FROM control_audit_comparison_sources
  WHERE company_id=${ctx.principal.companyId}::uuid AND snapshot_id=${snapshotId}::uuid` as {protected_header:SnapshotIndexEnvelope}[];
 if(rows.length!==1||!rows[0])throw new Error('Comparison source projection unavailable');
 const header=openComparisonSourceHeader(rows[0].protected_header,{companyId:ctx.principal.companyId,snapshotId,canonicalHash:expectedCanonicalHash});
 const counts={records:original.counts.records,checks:original.counts.checks,evidence:original.counts.evidence,evidenceGaps:original.counts.gaps};
 if(canonicalJson(original.permissions)!==canonicalJson(header.permissions)||canonicalJson(counts)!==canonicalJson(header.counts))throw new Error('Comparison source differs from retained index');
 const census=await ctx.sql`SELECT section,count(*)::text AS count FROM control_audit_comparison_source_items
  WHERE company_id=${ctx.principal.companyId}::uuid AND snapshot_id=${snapshotId}::uuid GROUP BY section` as {section:ComparisonSection;count:string}[];
 if(census.some(row=>!COMPARISON_SECTIONS.includes(row.section)))throw new Error('Invalid comparison section population');
 for(const section of COMPARISON_SECTIONS){const total=Number(census.find(row=>row.section===section)?.count??0);
  if(!Number.isSafeInteger(total)||total!==header.counts[section])throw new Error('Comparison source population count mismatch');}
 issued.add(header);return header;
}
/** At most256 encrypted items and2MiB ciphertext per query; SQL cancellation is the owning worker's responsibility. */
export async function* iterateComparisonSourceItems(ctx:ControlTx,header:ComparisonSourceHeader,section:ComparisonSection,options?:ComparisonOptions):AsyncGenerator<ComparisonItem>{
 const check=indexBudget(options);check();assertControlTx(ctx);
 if(!issued.has(header)||header.companyId!==ctx.principal.companyId||!COMPARISON_SECTIONS.includes(section))throw new Error('Authorized comparison source header required');
 let position=0;await assertOriginal(ctx,header);check();
 while(position<header.counts[section]){
  if(position){await assertOriginal(ctx,header);check();}
  const rows=await ctx.sql`WITH candidates AS (
   SELECT position,protected_item FROM control_audit_comparison_source_items
   WHERE company_id=${ctx.principal.companyId}::uuid AND snapshot_id=${header.snapshotId}::uuid
    AND section=${section} AND position>=${position} ORDER BY position LIMIT 256
  ), bounded AS (SELECT position,protected_item,sum(octet_length(protected_item::text)) OVER(ORDER BY position) AS bytes FROM candidates)
  SELECT position,protected_item FROM bounded WHERE bytes<=2097152 ORDER BY position` as {position:number;protected_item:SnapshotIndexEnvelope}[];
  check();if(!rows.length)throw new Error('Comparison source population incomplete');
  for(const row of rows){check();if(row.position!==position||position>=header.counts[section])throw new Error('Comparison source position changed');
   const item=openComparisonSourceItem(row.protected_item,header,section,position);position++;yield item;
  }
 }
 check();if(position!==header.counts[section])throw new Error('Comparison source population count mismatch');
}
