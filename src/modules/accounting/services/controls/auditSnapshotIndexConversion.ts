import type {ControlTx} from './contracts';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {readComparisonIntentInputs} from './auditComparisonIntentInputs';
import {readAuditSnapshotIndexHeader} from './auditSnapshotIndexRead';
import {readRetainedAuditSnapshot} from './auditSnapshotPublication';
import {buildSnapshotIndex,openSnapshotIndexItem} from './auditSnapshotIndexMaterial';
import {retainSnapshotIndexMaterial} from './auditSnapshotIndexRows';
import {indexBudget} from './auditSnapshotIndexValidation';
import {canonicalJson} from './canonical';
import {SNAPSHOT_INDEX_SECTIONS,type SnapshotIndexHeader,type SnapshotIndexEnvelope} from './auditSnapshotIndexContract';

type Options={signal?:AbortSignal;deadlineAt?:number};
/** Verify complete descriptor/chunk population without loading the original seal or artifact bytes. */
async function census(ctx:ControlTx,header:SnapshotIndexHeader,check:()=>void){
 const counts=await ctx.sql`SELECT section,count(*)::integer AS count,min(ordinal) AS first,max(ordinal) AS last
  FROM control_audit_snapshot_index_items WHERE company_id=${header.companyId}::uuid AND snapshot_id=${header.snapshotId}::uuid GROUP BY section` as {section:string;count:number;first:number;last:number}[];
 if(counts.some(row=>!SNAPSHOT_INDEX_SECTIONS.includes(row.section as typeof SNAPSHOT_INDEX_SECTIONS[number])))throw new Error('Original index population changed');
 for(const section of SNAPSHOT_INDEX_SECTIONS){
  const total=header.counts[section],count=counts.find(row=>row.section===section);
  if((count?.count??0)!==total||(total>0&&(count?.first!==0||count.last!==total-1)))throw new Error('Original index population incomplete');
  for(let start=0;start<total;start+=256){
   check();
   const rows=await ctx.sql`SELECT i.ordinal,
    CASE WHEN octet_length(i.protected_item::text)<=8192 THEN i.protected_item ELSE NULL END AS protected_item,
    c.count,c.first,c.last
    FROM control_audit_snapshot_index_items i
    CROSS JOIN LATERAL (SELECT count(*)::integer AS count,min(chunk_ordinal) AS first,max(chunk_ordinal) AS last
     FROM control_audit_snapshot_index_chunks c WHERE c.company_id=i.company_id AND c.snapshot_id=i.snapshot_id
      AND c.section=i.section AND c.ordinal=i.ordinal) c
    WHERE i.company_id=${header.companyId}::uuid AND i.snapshot_id=${header.snapshotId}::uuid AND i.section=${section}
     AND i.ordinal>=${start} AND i.ordinal<${Math.min(total,start+256)} ORDER BY i.ordinal` as {ordinal:number;protected_item:SnapshotIndexEnvelope|null;count:number;first:number|null;last:number|null}[];
   if(rows.length!==Math.min(256,total-start))throw new Error('Original index descriptor population incomplete');
   for(const [offset,row] of rows.entries()){
    check();if(row.ordinal!==start+offset||!row.protected_item)throw new Error('Original index descriptor unavailable');
    const item=openSnapshotIndexItem(row.protected_item,header,section,row.ordinal);
    if(row.count!==item.chunkCount||row.first!==0||row.last!==item.chunkCount-1)throw new Error('Original index chunk population incomplete');
   }
  }
 }
 check();
}
/** Worker-only conversion; caller holds ordered source locks and the enclosing publication savepoint. */
export async function ensureOriginalSnapshotIndex(ctx:ControlTx,lease:AuditJobLease,snapshotId:string,options?:Options):Promise<SnapshotIndexHeader>{
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId
  ||ctx.principal.jobGeneration!==lease.generation)throw new Error('Original index conversion requires delegated comparison worker authority');
 const check=indexBudget(options);check();
 const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
 if(saved.kind!=='audit_compare')throw new Error('Original index conversion requires comparison job kind');
 if(snapshotId!==saved.request.firstSnapshotId&&snapshotId!==saved.request.secondSnapshotId)throw new Error('Original index conversion source differs from request');
 const inputs=await readComparisonIntentInputs(ctx,saved.request);
 const source=snapshotId===saved.request.firstSnapshotId?inputs.first:inputs.second;
 const pinned='firstCanonicalHash' in saved.request
  ?snapshotId===saved.request.firstSnapshotId?saved.request.firstCanonicalHash:saved.request.secondCanonicalHash:undefined;
 const existing=await ctx.sql`SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=${lease.companyId}::uuid AND snapshot_id=${snapshotId}::uuid`;
 if(existing.length>1)throw new Error('Original index identity ambiguous');
 if(!existing.length){
  const retained=await readRetainedAuditSnapshot(ctx,snapshotId);check();
  if(pinned&&retained.sealed.canonicalHash!==pinned)throw new Error('Original snapshot pinned hash changed');
  const material=await buildSnapshotIndex(retained.sealed,retained.artifacts,[...source.permissions],options);check();
  try{await retainSnapshotIndexMaterial(ctx,lease,snapshotId,material,options);}
  catch(error){
   if(error&&typeof error==='object'&&'code' in error&&error.code==='23505'&&'constraint' in error&&error.constraint==='control_audit_snapshot_indexes_pkey'){
    throw Object.assign(new Error('Concurrent original index conversion requires retry'),{code:'40001'});
   }
   throw error;
  }
 }
 const header=await readAuditSnapshotIndexHeader(ctx,snapshotId);
 if((pinned&&header.canonicalHash!==pinned)||canonicalJson(header.permissions)!==canonicalJson([...source.permissions].sort()))throw new Error('Original index source identity or permissions changed');
 await census(ctx,header,check);
 await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
 await readComparisonIntentInputs(ctx,saved.request);check();return header;
}
