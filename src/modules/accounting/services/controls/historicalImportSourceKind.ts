import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {UUID_RE} from '@/lib/validation';
import {assertControlTx} from './context';
import {openProtectedChange,type ProtectedChange} from './changeProtection';
import {decodeHistoricalImportSource} from './historicalImportSourceService';
import {assertPlatformImportSourceRead} from './platformImportConfinement';
import type {ControlTx} from './contracts';
import type {HistoricalImportKind} from './historicalImportTypes';
const kinds=['gl','opening_balance','customer_invoice','supplier_invoice'];
type Row={id:string;content_hash:string;normalized_hash:string;source_digest:string;source_key:string;source_version:number;
 event_id:string|null;evidence_id:string|null;metadata:string|null;key_id:string|null;envelope_version:number|null};
/** Authenticate a bounded kind proof without transferring the retained financial source artifact. */
export async function readHistoricalImportSourceKind(ctx:ControlTx,id:string):Promise<HistoricalImportKind|null>{
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:imports');
 if(!UUID_RE.test(id))throw new Error('Invalid historical source identity');id=id.toLowerCase();
 await assertPlatformImportSourceRead(ctx,id);
 const rows=await ctx.sql`SELECT s.id,s.content_hash,s.normalized_hash,
  encode(sha256(convert_to(s.payload_envelope->>'ciphertext','UTF8')),'hex') AS source_digest,
  s.payload_envelope->>'keyId' AS source_key,(s.payload_envelope->>'version')::int AS source_version,
  e.id AS event_id,p.id AS evidence_id,p.key_id,p.envelope_version,
  CASE WHEN octet_length(p.ciphertext)<=65536 THEN p.ciphertext ELSE NULL END AS metadata
  FROM control_historical_import_sources s LEFT JOIN control_change_events e ON e.company_id=s.company_id
   AND e.entity_type='historical_import_source' AND e.entity_id=s.id::text AND e.new_version=1
   AND e.action='historical_import.source_staged'
  LEFT JOIN control_protected_evidence p ON p.company_id=e.company_id AND p.id=e.protected_evidence_id
   AND p.entity_type=e.entity_type AND p.entity_id=e.entity_id
  WHERE s.company_id=${ctx.principal.companyId}::uuid AND s.id=${id}::uuid` as Row[];
 if(rows.length!==1)throw new Error('History domain metadata unavailable');
 const row=rows[0]!;
 if(row.event_id){
  if(!row.evidence_id||!row.metadata||!row.key_id||row.envelope_version!==1)throw new Error('History kind metadata unavailable');
  const body=openProtectedChange({version:1,keyId:row.key_id,ciphertext:row.metadata}).after;
  if(!body||body.sourceId!==id||body.contentHash!==row.content_hash||body.normalizedHash!==row.normalized_hash)throw new Error('History kind metadata changed');
  if('kind' in body){
   if(body.sourceCompanyId!==ctx.principal.companyId||typeof body.kind!=='string'||!kinds.includes(body.kind)||body.sourceEnvelopeHash!==row.source_digest
    ||body.sourceEnvelopeKeyId!==row.source_key||body.sourceEnvelopeVersion!==row.source_version)throw new Error('History kind metadata changed');
   return body.kind as HistoricalImportKind;
  }
 }
 // Legacy source events had no kind proof. Decode only a bounded original; never invent missing provenance.
 const legacy=await ctx.sql`SELECT id,company_id,content_hash,normalized_hash,mime_type,byte_length,record_count,
  CASE WHEN octet_length(payload_envelope::text)<=65536 THEN payload_envelope ELSE NULL END AS payload_envelope
  FROM control_historical_import_sources WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid` as (Record<string,unknown>&{payload_envelope:ProtectedChange|null})[];
 if(legacy.length!==1)throw new Error('History domain metadata unavailable');
 if(!legacy[0]!.payload_envelope)return null;
 return decodeHistoricalImportSource(ctx,legacy[0]!).normalized.kind;
}
