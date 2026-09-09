import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {UUID_RE} from '@/lib/validation';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {MAX_BANK_ATTACHMENT_URL_LENGTH,readBankAttachmentStorageEvidence,type BankAttachmentStorageEvidence} from './bankAttachmentEvidenceStorage';
interface AttachmentRow{id:string;bank_transaction_id:string;file_url:string|null;file_size:number|null;oversized:boolean}
export type OwnedBankAttachmentEvidence={id:string;parentId:string}&BankAttachmentStorageEvidence;
/** The parent is the attachment's tenant boundary. Preserve authority/SQL errors unchanged. */
export async function loadOwnedBankAttachmentEvidence(ctx:ControlTx,id:string,signal?:AbortSignal):Promise<OwnedBankAttachmentEvidence|null>{
 assertControlTx(ctx);if(!UUID_RE.test(id))throw new Error('Invalid bank attachment evidence identity');
 await assertEffectivePermission(ctx,'read:bank-tx');
 const [row]=await ctx.sql`SELECT a.id,a.bank_transaction_id,a.file_size,
   CASE WHEN length(a.file_url)<=${MAX_BANK_ATTACHMENT_URL_LENGTH} THEN a.file_url ELSE NULL END AS file_url,
   COALESCE(length(a.file_url)>${MAX_BANK_ATTACHMENT_URL_LENGTH},false) AS oversized
  FROM bank_transaction_attachments a JOIN bank_transactions b ON b.id=a.bank_transaction_id
  WHERE a.id=${id}::uuid AND b.company_id=${ctx.principal.companyId}::uuid FOR SHARE OF a,b` as AttachmentRow[];
 signal?.throwIfAborted();
 if(!row)return null;
 const identity={id:row.id,parentId:row.bank_transaction_id};
 if(row.oversized)return{...identity,status:'unavailable',reason:'attachment_resource_limit'};
 return{...identity,...await readBankAttachmentStorageEvidence({fileUrl:row.file_url,recordedSize:row.file_size},signal)};
}
