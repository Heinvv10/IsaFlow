import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {importMoney} from './historicalImportExactPlan';
import {UUID_RE} from '@/lib/validation';
import {assertControlTx} from './context';
import {canonicalJson} from './canonical';
import {openProtectedChange,type ProtectedChange} from './changeProtection';
import {readControlEntityVersion} from './operationVersions';
import {historicalHash,readHistoricalImportSource} from './historicalImportSourceService';
import {loadHistoricalImportCurrentFacts} from './historicalImportCurrentFacts';
import type {ApMaterial,ObservedSource} from './apOperationMaterializer';
import type {ControlTx,OperationRef} from './contracts';
type Row=Record<string,unknown>;
export async function materializeHistoricalImportOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:imports');
 if(ref.entityType!=='historical_import'||ref.operation!=='historical_import.post'||!UUID_RE.test(ref.entityId))throw new Error('Unsupported historical import operation');
 const rows=await ctx.sql`SELECT *,accounting_date::text,amount::text FROM control_historical_imports
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid` as Row[];
 const intent=rows[0];if(rows.length!==1||!intent)throw new Error('Historical import unavailable');
 const source=await readHistoricalImportSource(ctx,String(intent.source_id));
 const body=openProtectedChange(intent.payload_envelope as ProtectedChange).after;
 if(!body||body.companyId!==ctx.principal.companyId||body.importId!==intent.id||body.sourceId!==intent.source_id||body.requesterPersonId!==intent.requester_person_id
  ||body.requesterAuthMethod!==intent.requester_auth_method||body.requesterGrantId!==intent.requester_grant_id||canonicalJson(body.requesterGrantedScopes)!==canonicalJson(intent.requester_granted_scopes)
  ||historicalHash(canonicalJson(body))!==intent.payload_hash||body.contentHash!==source.contentHash||body.normalizedHash!==source.normalizedHash
  ||canonicalJson(body.normalized)!==canonicalJson(source.normalized))throw new Error('Historical import payload unavailable or changed');
 const normalized=source.normalized;
 if(intent.source_system!==normalized.sourceSystem||intent.source_key!==normalized.sourceKey||intent.kind!==normalized.kind||intent.mode!==normalized.mode
  ||intent.accounting_date!==normalized.accountingDate||intent.currency!==normalized.currency||importMoney(intent.amount)!==normalized.amount)throw new Error('Historical import metadata differs from source');
 const current=await loadHistoricalImportCurrentFacts(ctx,normalized);
 if(canonicalJson(body.resolvedPlan)!==canonicalJson(current.plan))throw new Error('Historical resolved account plan changed');
 const facts={intent:{id:intent.id,sourceId:intent.source_id,payloadHash:intent.payload_hash,requesterPersonId:intent.requester_person_id},
  source:{sourceId:source.sourceId,contentHash:source.contentHash,normalizedHash:source.normalizedHash,normalized},...current};
 const prior=await readControlEntityVersion(ctx,ref),version=prior?.version??1;
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==version)throw new Error('Historical import version changed');
 const observed:ObservedSource={entityType:ref.entityType,entityId:ref.entityId,version,tracked:prior!==null,facts,fingerprint:historicalHash(canonicalJson(facts))};
 const sourcePrior=await readControlEntityVersion(ctx,{entityType:'historical_import_source',entityId:source.sourceId});
 const sourceObserved:ObservedSource={entityType:'historical_import_source',entityId:source.sourceId,version:sourcePrior?.version??1,tracked:sourcePrior!==null,
  facts:{sourceId:source.sourceId,contentHash:source.contentHash,normalizedHash:source.normalizedHash},fingerprint:source.normalizedHash};
 const observedSources=[observed,sourceObserved];
 return{supplierId:normalized.kind==='supplier_invoice'?normalized.document!.partyId:'',observedSources,
  versionBasis:observedSources.every(s=>s.tracked)?'recorded_with_current_fingerprint':'untracked_current_observation',
  binding:{companyId:ctx.principal.companyId,operation:'historical_import.post',entityType:'historical_import',entityId:ref.entityId,entityVersion:version,
   accountingDate:normalized.accountingDate,amount:normalized.amount,currency:normalized.currency,beneficiaries:[],
   sourceVersions:observedSources.map(({facts:_facts,tracked:_tracked,...source})=>source)}};
}
