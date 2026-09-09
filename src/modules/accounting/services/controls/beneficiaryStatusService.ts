import {z} from 'zod';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {ProtectedChange} from './changeProtection';
import {canonicalJson} from './canonical';
import {bankFingerprint,normalizeBeneficiaryDetails,openBeneficiary} from './beneficiaryValidation';
const inputSchema=z.object({supplierId:z.string().uuid(),proposalId:z.string().uuid().optional()}).strict();
type Row=Record<string,unknown>;
export interface SupplierBankChangeStatus {
 supplierId:string;pendingHold:boolean;
 currentBank:{verification:'verified'|'legacy_unverified'|'changed_since_verification';verifiedVersion:number|null;accountLast4:string|null};
 proposal:null|{proposalId:string;status:'pending'|'verified'|'rejected'|'cancelled';createdAt:string;verifiedAt:string|null;requestedByCurrentPerson:boolean;accountLast4:string};
}
const date=(value:unknown):string=>{const d=value instanceof Date?value:new Date(String(value));if(!Number.isFinite(d.getTime()))throw new Error('Invalid retained beneficiary date');return d.toISOString();};
/** Current owned status only: never returns decrypted banking or takes financial write locks. */
export async function readSupplierBankChangeStatus(ctx:ControlTx,input:{supplierId:string;proposalId?:string}):Promise<SupplierBankChangeStatus>{
 const {supplierId,proposalId}=inputSchema.parse(JSON.parse(canonicalJson(input)));
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:contacts');
 const company=ctx.principal.companyId;
 const [row]=await ctx.sql`SELECT bank_name,bank_account_number,bank_branch_code,bank_account_type FROM suppliers
  WHERE company_id=${company}::uuid AND id=${supplierId}::uuid AND deleted_at IS NULL AND is_active=true` as Row[];
 if(!row)throw new Error('Not found');
 const ref={entityType:'supplier' as const,entityId:supplierId};
 const live={bankName:row.bank_name,accountNumber:row.bank_account_number,branchCode:row.bank_branch_code,accountType:row.bank_account_type};
 const [version]=await ctx.sql`SELECT version,details_envelope,fingerprint FROM control_beneficiary_versions
  WHERE company_id=${company}::uuid AND entity_type='supplier' AND entity_id=${supplierId}::uuid ORDER BY version DESC LIMIT 1` as Row[];
 const [pending]=await ctx.sql`SELECT id FROM control_beneficiary_proposals WHERE company_id=${company}::uuid
  AND entity_type='supplier' AND entity_id=${supplierId}::uuid AND status='pending' LIMIT 1` as Row[];
 const [proposal]=await ctx.sql`SELECT id,status,created_at,verified_at,requester_person_id,details_envelope,details_fingerprint
  FROM control_beneficiary_proposals WHERE company_id=${company}::uuid AND entity_type='supplier' AND entity_id=${supplierId}::uuid
  AND (${proposalId??null}::uuid IS NULL OR id=${proposalId??null}::uuid)
  ORDER BY (status='pending') DESC,created_at DESC,id DESC LIMIT 1` as Row[];
 if(proposalId&&!proposal)throw new Error('Not found');
 let normalized:ReturnType<typeof normalizeBeneficiaryDetails>|null=null;
 try{normalized=normalizeBeneficiaryDetails(live);}catch{normalized=null; /* Legacy malformed banking has no verification claim. */}
 let verifiedVersion:number|null=null;
 let verification:SupplierBankChangeStatus['currentBank']['verification']='legacy_unverified';
 if(version){
  openBeneficiary(company,ref,version.details_envelope as ProtectedChange,String(version.fingerprint));
  verifiedVersion=Number(version.version);if(!Number.isSafeInteger(verifiedVersion)||verifiedVersion<1)throw new Error('Invalid retained beneficiary version');
  verification=normalized&&bankFingerprint(company,ref,normalized)===version.fingerprint?'verified':'changed_since_verification';
 }
 let selected:SupplierBankChangeStatus['proposal']=null;
 if(proposal){
  const details=openBeneficiary(company,ref,proposal.details_envelope as ProtectedChange,String(proposal.details_fingerprint));
  const status=z.enum(['pending','verified','rejected','cancelled']).parse(proposal.status);
  selected={proposalId:String(proposal.id),status,createdAt:date(proposal.created_at),verifiedAt:proposal.verified_at===null?null:date(proposal.verified_at),
   requestedByCurrentPerson:proposal.requester_person_id===ctx.principal.personId,accountLast4:details.accountNumber.slice(-4)};
 }
 return{supplierId,pendingHold:!!pending,currentBank:{verification,verifiedVersion,accountLast4:normalized?.accountNumber.slice(-4)??null},proposal:selected};
}
