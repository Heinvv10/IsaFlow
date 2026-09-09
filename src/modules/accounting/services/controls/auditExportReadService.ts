import {z} from 'zod';
import {canonicalJson} from './canonical';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {readAuditExportHeader} from './auditExportReadHeader';
import {openExportDeliveryFile,openExportDeliveryChunk} from './auditExportDeliveryMaterial';
import {EXPORT_DELIVERY_LIMITS as limits,type ExportDeliveryEnvelope} from './auditExportDeliveryContract';
const jobId=z.string().uuid().transform(id=>id.toLowerCase());
const pageSchema=z.object({jobId,limit:z.number().int().min(1).max(limits.pageFiles).default(100),
 cursor:z.string().regex(/^(0|[1-9][0-9]{0,5})$/).optional()}).strict();
const chunkSchema=z.object({jobId,fileOrdinal:z.number().int().min(0).max(limits.maxFiles-1),
 chunkOrdinal:z.number().int().min(0).max(limits.bundleBytes/limits.chunkBytes-1)}).strict();
/** Metadata only: exact signed population and <=100 contiguous authenticated file descriptors. */
export async function getAuditExportFiles(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const request=pageSchema.parse(JSON.parse(canonicalJson(input)));
 const header=await readAuditExportHeader(ctx,request.jobId),start=Number(request.cursor??0);
 if(start>header.fileCount)throw new Error('Invalid export file cursor');
 const rows=await ctx.sql`SELECT file_ordinal,protected_file FROM control_audit_export_files
  WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${request.jobId}::uuid
   AND generation=${header.generation} AND lease_id=${header.leaseId}::uuid AND file_ordinal>=${start}
  ORDER BY file_ordinal LIMIT ${request.limit}` as {file_ordinal:number;protected_file:ExportDeliveryEnvelope}[];
 if(rows.length!==Math.min(request.limit,header.fileCount-start))throw new Error('Export file page incomplete');
 const files=rows.map((row,index)=>{
  if(row.file_ordinal!==start+index)throw new Error('Export file page incomplete');
  return openExportDeliveryFile(row.protected_file,header,row.file_ordinal);
 });
 const next=start+files.length;
 return{jobId:request.jobId,generation:header.generation,fileCount:header.fileCount,files,nextCursor:next<header.fileCount?String(next):null};
}
/** One independently authenticated <=256KiB chunk; never loads the complete export or manifest. */
export async function readAuditExportChunk(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const request=chunkSchema.parse(JSON.parse(canonicalJson(input)));
 const header=await readAuditExportHeader(ctx,request.jobId);
 if(request.fileOrdinal>=header.fileCount)throw new Error('Invalid export file ordinal');
 const rows=await ctx.sql`SELECT protected_file FROM control_audit_export_files
  WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${request.jobId}::uuid
   AND generation=${header.generation} AND lease_id=${header.leaseId}::uuid AND file_ordinal=${request.fileOrdinal}` as {protected_file:ExportDeliveryEnvelope}[];
 if(rows.length!==1||!rows[0])throw new Error('Export file unavailable');
 const file=openExportDeliveryFile(rows[0].protected_file,header,request.fileOrdinal);
 if(request.chunkOrdinal>=file.chunkCount)throw new Error('Invalid export chunk ordinal');
 const chunks=await ctx.sql`SELECT protected_chunk FROM control_audit_export_chunks
  WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${request.jobId}::uuid
   AND generation=${header.generation} AND lease_id=${header.leaseId}::uuid
   AND file_ordinal=${request.fileOrdinal} AND chunk_ordinal=${request.chunkOrdinal}` as {protected_chunk:ExportDeliveryEnvelope}[];
 if(chunks.length!==1||!chunks[0])throw new Error('Export chunk unavailable');
 return{file,chunkOrdinal:request.chunkOrdinal,bytes:openExportDeliveryChunk(chunks[0].protected_chunk,file,request.chunkOrdinal)};
}
