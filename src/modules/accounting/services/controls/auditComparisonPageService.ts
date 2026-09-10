import {z} from 'zod';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {canonicalJson} from './canonical';
import {COMPARISON_SECTIONS} from './auditSnapshotComparisonMaterial';
import {readAuditComparisonHeader} from './auditComparisonReadHeader';
import {openComparisonResultItem} from './auditComparisonResultProtection';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
const schema=z.object({comparisonId:z.string().uuid().transform(id=>id.toLowerCase()),section:z.enum(COMPARISON_SECTIONS),
 limit:z.number().int().min(1).max(100).default(100),cursor:z.string().regex(/^(0|[1-9][0-9]{0,5})$/).optional()}).strict();
/** Each item is authenticated; canonicalHash is the publisher's full-result digest, not a page-only rehash. */
export async function getAuditComparisonPage(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const request=schema.parse(JSON.parse(canonicalJson(input)));
 const header=await readAuditComparisonHeader(ctx,request.comparisonId),counts=header.counts[request.section];
 const total=counts.added+counts.removed+counts.changed,start=Number(request.cursor??0);
 if(start>total)throw new Error('Invalid comparison page cursor');
 const rows=await ctx.sql`WITH candidates AS (
  SELECT position,protected_item FROM control_audit_comparison_items
  WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${request.comparisonId}::uuid
   AND generation=${header.generation} AND lease_id=${header.leaseId}::uuid
   AND section=${request.section} AND position>=${start} ORDER BY position LIMIT ${request.limit}
 ), bounded AS (SELECT position,protected_item,sum(octet_length(protected_item::text)) OVER(ORDER BY position) AS bytes FROM candidates)
 SELECT position,protected_item FROM bounded WHERE bytes<=2097152 ORDER BY position` as {position:number;protected_item:SnapshotIndexEnvelope}[];
 // Valid compact change envelopes fit the byte budget at the maximum page size. Never conceal omitted rows.
 if(rows.length!==Math.min(request.limit,total-start))throw new Error('Comparison page incomplete or encrypted byte budget exceeded');
 const items=rows.map((row,index)=>{
  if(row.position!==start+index)throw new Error('Comparison page position changed');
  return openComparisonResultItem(row.protected_item,header,request.section,row.position);
 });
 const next=start+items.length;
 return{comparisonId:request.comparisonId,canonicalHash:header.canonicalHash,comparisonRuleVersion:header.comparisonRuleVersion,
  first:header.first,second:header.second,counts:header.counts,populationChanged:header.populationChanged,coverageChanged:header.coverageChanged,
  section:request.section,total,items,nextCursor:next<total?String(next):null};
}
