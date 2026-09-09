import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from './canonical';
const MAX_BYTES=2*1024*1024;
export const MAX_BANK_ATTACHMENT_URL_LENGTH=4*Math.ceil(MAX_BYTES/3)+256;
const descriptor=z.object({fileUrl:z.string().nullable(),recordedSize:z.number().int().nullable()}).strict();
export type BankAttachmentStorageDescriptor=z.infer<typeof descriptor>;
export type BankAttachmentStorageEvidence=
 |{status:'available';bytes:Uint8Array;sha256:string;recordedHashVerified:false;mediaType:string}
 |{status:'unavailable';reason:'attachment_bytes_missing'|'unsupported_attachment_source'|'attachment_encoding_invalid'|'attachment_resource_limit'|'attachment_size_mismatch'};
/** Actual bank attachment writers store bounded inline data URLs, never an external storage path. */
export async function readBankAttachmentStorageEvidence(input:BankAttachmentStorageDescriptor,signal?:AbortSignal):Promise<BankAttachmentStorageEvidence>{
 const saved=descriptor.parse(JSON.parse(canonicalJson(input)));
 signal?.throwIfAborted();
 if(!saved.fileUrl)return{status:'unavailable',reason:'attachment_bytes_missing'};
 if(saved.fileUrl.length>MAX_BANK_ATTACHMENT_URL_LENGTH)return{status:'unavailable',reason:'attachment_resource_limit'};
 if(!saved.fileUrl.startsWith('data:'))return{status:'unavailable',reason:'unsupported_attachment_source'};
 const match=/^data:([a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(saved.fileUrl);
 if(!match||!match[2]||match[2].length%4!==0)return{status:'unavailable',reason:'attachment_encoding_invalid'};
 const bytes=Buffer.from(match[2],'base64');
 if(bytes.length>MAX_BYTES)return{status:'unavailable',reason:'attachment_resource_limit'};
 if(!bytes.length||bytes.toString('base64')!==match[2])return{status:'unavailable',reason:'attachment_encoding_invalid'};
 if(saved.recordedSize!==null&&saved.recordedSize!==bytes.length)return{status:'unavailable',reason:'attachment_size_mismatch'};
 const sha256=createHash('sha256').update(bytes).digest('hex');
 signal?.throwIfAborted();
 return{status:'available',bytes,sha256,recordedHashVerified:false,mediaType:match[1]!};
}
