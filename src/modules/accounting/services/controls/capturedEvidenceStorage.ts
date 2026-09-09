import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from './canonical';
const MAX_BYTES=10*1024*1024;
const descriptor=z.object({companyId:z.string().uuid(),documentId:z.string().uuid(),bucket:z.string().min(1).max(256),
 path:z.string().min(1).max(512),recordedHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
 recordedSize:z.number().int().positive().max(MAX_BYTES).nullable(),mediaType:z.string().min(1).max(256)}).strict();
export type CapturedStorageDescriptor=z.infer<typeof descriptor>;
export interface CapturedStorageEvidence{bytes:Uint8Array;sha256:string;recordedHashVerified:boolean;mediaType:string}
/** Internal storage adapter. Callers first establish current domain permission and owned document/parent rows. */
export async function readCapturedStorageEvidence(input:CapturedStorageDescriptor,signal?:AbortSignal):Promise<CapturedStorageEvidence|null>{
 const saved=descriptor.parse(JSON.parse(canonicalJson(input)));
 const bucket=process.env.SUPABASE_CAPTURED_DOCS_BUCKET??'captured-documents';
 if(saved.bucket!==bucket||saved.path!==`${saved.companyId}/${saved.documentId}`)throw new Error('Captured evidence storage namespace mismatch');
 const base=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!base||!key)throw new Error('Captured evidence storage configuration unavailable');
 const origin=new URL(base);
 if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.search||origin.hash)throw new Error('Invalid captured evidence storage configuration');
 const url=`${origin.toString().replace(/\/$/,'')}/storage/v1/object/${encodeURIComponent(bucket)}/${saved.path.split('/').map(encodeURIComponent).join('/')}`;
 const timeout=AbortSignal.timeout(10000),active=signal?AbortSignal.any([signal,timeout]):timeout;
 const response=await fetch(url,{headers:{apikey:key,Authorization:`Bearer ${key}`},redirect:'error',cache:'no-store',signal:active})
  .catch(()=>{throw new Error('Captured evidence storage request failed or cancelled');});
 if(!response.ok){
  await response.body?.cancel();
  if(response.status===404)return null;
  throw new Error('Captured evidence storage request failed');
 }
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BYTES)){
  await response.body?.cancel();throw new Error('Captured evidence byte resource limit');
 }
 if(!response.body)throw new Error('Captured evidence storage body missing');
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let total=0,completed=false;
 try{
  for(;;){
   const next=await reader.read();if(next.done){completed=true;break;}
   total+=next.value.byteLength;
   if(total>MAX_BYTES)throw new Error('Captured evidence byte resource limit');
   parts.push(next.value);
  }
 }finally{
  try{if(!completed)await reader.cancel();}finally{reader.releaseLock();}
 }
 const bytes=Buffer.concat(parts,total),sha256=createHash('sha256').update(bytes).digest('hex');
 if(!total||(saved.recordedSize!==null&&saved.recordedSize!==total)||(saved.recordedHash!==null&&saved.recordedHash!==sha256))
  throw new Error('Captured evidence bytes changed or empty');
 return{bytes,sha256,recordedHashVerified:saved.recordedHash!==null,mediaType:saved.mediaType};
}
