import {isActiveUserAccount} from '@/lib/auth/userAccountStatus';
import {assertControlTx} from './context';
import {canonicalJson} from './canonical';
import {openProtectedChange,type ProtectedChange} from './changeProtection';
import {historicalHash,readHistoricalImportSource} from './historicalImportSourceService';
import type {ApprovalRow,AuthorityRow} from './approvalQueries';
import type {ControlTx} from './contracts';
/** A retained platform requester is a distinct authority kind, never a fabricated tenant administrator. */
export async function assertPlatformImportRequester(ctx:ControlTx,row:ApprovalRow,authority:AuthorityRow|undefined){
 assertControlTx(ctx);
 if(row.company_id!==ctx.principal.companyId||row.binding.companyId!==row.company_id
  ||row.binding.entityType!=='historical_import'||row.binding.operation!=='historical_import.post'
  ||!authority||authority.authority_kind!=='platform_import'||authority.platform_role!=='super_admin'
  ||authority.person_id!==row.requester_person_id||!isActiveUserAccount(authority)||authority.grant_valid!==true
  ||authority.current_scopes!==null||authority.company_suspended_at!==null
  ||['suspended','deleted'].includes(authority.company_status??''))throw new Error('Platform requester authority is no longer valid');
 const rows=await ctx.sql`SELECT * FROM control_historical_imports
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${row.binding.entityId}::uuid` as Record<string,unknown>[];
 const intent=rows[0];
 if(rows.length!==1||!intent||intent.requester_person_id!==row.requester_person_id||intent.requester_auth_method!=='platform_import'
  ||intent.requester_grant_id!==null||intent.requester_granted_scopes!==null)throw new Error('Platform requester import association changed');
 const body=openProtectedChange(intent.payload_envelope as ProtectedChange).after;
 if(!body||body.companyId!==row.company_id||body.importId!==intent.id||body.sourceId!==intent.source_id
  ||body.requesterPersonId!==row.requester_person_id||body.requesterAuthMethod!=='platform_import'
  ||body.requesterGrantId!==null||body.requesterGrantedScopes!==null
  ||historicalHash(canonicalJson(body))!==intent.payload_hash)throw new Error('Platform requester protected evidence changed');
 const source=await readHistoricalImportSource(ctx,String(intent.source_id));
 if(source.platformImportMaker!==row.requester_person_id||body.contentHash!==source.contentHash||body.normalizedHash!==source.normalizedHash
  ||canonicalJson(body.normalized)!==canonicalJson(source.normalized))throw new Error('Platform requester source evidence changed');
}
