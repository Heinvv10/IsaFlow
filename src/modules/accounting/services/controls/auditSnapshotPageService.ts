import {z} from 'zod';
import {canonicalJson} from './canonical';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {readAuditSnapshotIndexHeader} from './auditSnapshotIndexRead';
import {openSnapshotIndexItem,openSnapshotIndexChunk} from './auditSnapshotIndexMaterial';
import {SNAPSHOT_INDEX_LIMITS,SNAPSHOT_INDEX_SECTIONS,type SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
const fields={snapshotId:z.string().uuid(),section:z.enum(SNAPSHOT_INDEX_SECTIONS)};
const pageSchema=z.object({...fields,limit:z.number().int().min(1).max(SNAPSHOT_INDEX_LIMITS.pageItems).default(100),
 cursor:z.string().regex(/^(0|[1-9][0-9]{0,5})$/).optional()}).strict();
const chunkSchema=z.object({...fields,ordinal:z.number().int().min(0).max(SNAPSHOT_INDEX_LIMITS.maxItems-1),chunkOrdinal:z.number().int().min(0).max(1023)}).strict();
/** Complete signed section count plus at most 100 authenticated descriptors. Oversized items use bounded chunk reads. */
export async function getAuditSnapshotPage(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const request=pageSchema.parse(JSON.parse(canonicalJson(input)));
 const header=await readAuditSnapshotIndexHeader(ctx,request.snapshotId),start=Number(request.cursor??0),total=header.counts[request.section];
 if(start>total)throw new Error('Invalid snapshot index cursor');
 const rows=await ctx.sql`SELECT ordinal,protected_item FROM control_audit_snapshot_index_items
  WHERE company_id=${ctx.principal.companyId}::uuid AND snapshot_id=${request.snapshotId}::uuid AND section=${request.section}
   AND ordinal>=${start} ORDER BY ordinal LIMIT ${request.limit}` as {ordinal:number;protected_item:SnapshotIndexEnvelope}[];
 if(rows.length!==Math.min(request.limit,total-start))throw new Error('Retained snapshot index page incomplete');
 const items=rows.map((row,index)=>{
  if(row.ordinal!==start+index)throw new Error('Retained snapshot index page incomplete');
  return openSnapshotIndexItem(row.protected_item,header,request.section,row.ordinal);
 });
 const next=start+items.length;
 return{snapshotId:request.snapshotId,canonicalHash:header.canonicalHash,section:request.section,total,items,nextCursor:next<total?String(next):null};
}
/** No source query, renderer, enqueue, or full-snapshot decryption occurs here. */
export async function readAuditSnapshotChunk(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const request=chunkSchema.parse(JSON.parse(canonicalJson(input)));
 const header=await readAuditSnapshotIndexHeader(ctx,request.snapshotId);
 const items=await ctx.sql`SELECT protected_item FROM control_audit_snapshot_index_items WHERE company_id=${ctx.principal.companyId}::uuid
  AND snapshot_id=${request.snapshotId}::uuid AND section=${request.section} AND ordinal=${request.ordinal}` as {protected_item:SnapshotIndexEnvelope}[];
 if(items.length!==1||!items[0])throw new Error('Retained snapshot index item unavailable');
 const item=openSnapshotIndexItem(items[0].protected_item,header,request.section,request.ordinal);
 const chunks=await ctx.sql`SELECT protected_chunk FROM control_audit_snapshot_index_chunks WHERE company_id=${ctx.principal.companyId}::uuid
  AND snapshot_id=${request.snapshotId}::uuid AND section=${request.section} AND ordinal=${request.ordinal} AND chunk_ordinal=${request.chunkOrdinal}` as {protected_chunk:SnapshotIndexEnvelope}[];
 if(chunks.length!==1||!chunks[0])throw new Error('Retained snapshot index chunk unavailable');
 return{item,chunkOrdinal:request.chunkOrdinal,bytes:openSnapshotIndexChunk(chunks[0].protected_chunk,item,request.chunkOrdinal)};
}
