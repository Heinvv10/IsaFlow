import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from './canonical';
const MAX_BYTES=20*1024*1024;
const descriptor=z.object({companyId:z.string().uuid(),documentId:z.string().uuid(),entityType:z.enum(['supplier_invoice','supplier_payment','customer_invoice','customer_payment','credit_note','purchase_order','goods_receipt_note','goods_received_note','grn']),entityId:z.string().uuid(),
 path:z.string().min(1).max(512),
 recordedSize:z.number().int().positive().max(MAX_BYTES).nullable(),mediaType:z.string().min(1).max(256)}).strict();
export type ProcurementStorageDescriptor=z.infer<typeof descriptor>;
export interface ProcurementStorageEvidence{bytes:Uint8Array;sha256:string;recordedHashVerified:boolean;mediaType:string}
/** Internal storage adapter. Callers first establish current domain permission and owned document/parent rows. */
export async function readProcurementStorageEvidence(input:ProcurementStorageDescriptor,signal?:AbortSignal):Promise<ProcurementStorageEvidence|null>{
 const saved=descriptor.parse(JSON.parse(canonicalJson(input)));
 const prefix=`accounting/${saved.entityType}/${saved.entityId}_`;
 const filename=saved.path.slice(prefix.length);
 if(!saved.path.startsWith(prefix)||!filename||!/^[-a-zA-Z0-9._]+$/.test(filename))
  throw new Error('Procurement evidence storage namespace mismatch or unsupported filename rewrite');
 const base=process.env.VF_STORAGE_URL??'http://100.96.203.105:8091';
 const origin=new URL(base);
 if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')
  throw new Error('Invalid procurement evidence storage configuration');
 const url=`${origin.origin}/${saved.path.split('/').map(encodeURIComponent).join('/')}`;
 const timeout=AbortSignal.timeout(10000),active=signal?AbortSignal.any([signal,timeout]):timeout;
 const response=await fetch(url,{redirect:'error',cache:'no-store',signal:active})
  .catch(()=>{throw new Error('Procurement evidence storage request failed or cancelled');});
 if(!response.ok){
  await response.body?.cancel();
  if(response.status===404)return null;
  throw new Error('Procurement evidence storage request failed');
 }
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BYTES)){
  await response.body?.cancel();throw new Error('Procurement evidence byte resource limit');
 }
 if(!response.body)throw new Error('Procurement evidence storage body missing');
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let total=0,completed=false;
 try{
  for(;;){
   const next=await reader.read();if(next.done){completed=true;break;}
   total+=next.value.byteLength;
   if(total>MAX_BYTES)throw new Error('Procurement evidence byte resource limit');
   parts.push(next.value);
  }
 }finally{
  try{if(!completed)await reader.cancel();}finally{reader.releaseLock();}
 }
 const bytes=Buffer.concat(parts,total),sha256=createHash('sha256').update(bytes).digest('hex');
 if(!total||(saved.recordedSize!==null&&saved.recordedSize!==total))
  throw new Error('Procurement evidence bytes changed or empty');
 return{bytes,sha256,recordedHashVerified:false,mediaType:saved.mediaType};
}
