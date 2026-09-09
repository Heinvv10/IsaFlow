import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '../controls/context';
import {canonicalMoney} from '../controls/canonical';
import type {ControlTx,EvidenceRef} from '../controls/contracts';
import {queryThreeWayMatch} from './threeWayMatchQueryService';
/** Legacy source writers lack tenant phantom fences. Brief table locks provide a complete local source freeze. */
export async function withInvoiceMatchSourceLocks<T>(ctx:ControlTx,action:()=>Promise<T>):Promise<T>{
 assertControlTx(ctx);await assertEffectivePermission(ctx,'write:invoices');
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
 return withSavepoint('invoice_override_sources',async()=>{
  const [setting]=await ctx.sql`SELECT current_setting('lock_timeout') AS value` as {value:string}[];
  await ctx.sql`SELECT set_config('lock_timeout','2000ms',true)`;
  // Strong first lock prevents two annotations upgrading a shared version-table lock after reading.
  await ctx.sql`LOCK TABLE control_entity_versions IN SHARE ROW EXCLUSIVE MODE`;
  await ctx.sql`LOCK TABLE captured_documents,goods_received_notes,grn_items,po_items,purchase_orders,supplier_coding_rules,
   supplier_invoice_items,supplier_invoices,supplier_purchase_order_items,supplier_purchase_orders,suppliers IN SHARE MODE`;
  const result=await action();
  await ctx.sql`SELECT set_config('lock_timeout',${setting!.value},true)`;
  return result;
  // On error the savepoint rollback restores prior lock_timeout and releases locks acquired inside it.
 });
}
export async function loadInvoiceMatchCurrent(ctx:ControlTx,invoiceId:string){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:invoices');
 const [invoice]=await ctx.sql`SELECT id,supplier_id,invoice_date::text,total_amount::text,currency,status,deleted_at
  FROM supplier_invoices WHERE company_id=${ctx.principal.companyId}::uuid AND id=${invoiceId}::uuid` as
  {id:string;supplier_id:string;invoice_date:string;total_amount:string;currency:string;status:string;deleted_at:Date|string|null}[];
 if(!invoice||invoice.deleted_at||['cancelled','void','voided','rejected'].includes(invoice.status))throw new Error('Current owned eligible invoice required');
 if(!/^[A-Z]{3}$/.test(invoice.currency))throw new Error('Invoice currency unavailable');
 const match=await queryThreeWayMatch(ctx,{invoiceId});
 if(match.over||!match.results.length)throw new Error('Complete bounded invoice match material required');
 return{invoice,amount:canonicalMoney(invoice.total_amount),match};
}
export async function verifyInvoiceMatchEvidence(ctx:ControlTx,invoiceId:string,refs:readonly EvidenceRef[]){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:invoices');
 const verified:EvidenceRef[]=[];
 if(!Array.isArray(refs)||refs.length<1||refs.length>20)throw new Error('Override evidence required');
 for(const ref of refs){
  if(ref.store!=='captured'||ref.entityType!=='supplier_invoice'||ref.entityId!==invoiceId||ref.version!==null||!ref.hash
   ||!/^[a-f0-9]{64}$/.test(ref.hash)||verified.some(r=>r.evidenceId===ref.evidenceId))throw new Error('Same-invoice captured override evidence required');
  const [source]=await ctx.sql`SELECT d.id FROM captured_documents d JOIN supplier_invoices i ON i.company_id=d.company_id AND i.id=d.matched_invoice_id
   WHERE d.company_id=${ctx.principal.companyId}::uuid AND d.id=${ref.evidenceId}::uuid AND i.id=${invoiceId}::uuid
    AND d.status NOT IN ('deleted','rejected') AND d.raw_bytes IS NOT NULL AND octet_length(d.raw_bytes) BETWEEN 1 AND 10485760
    AND d.raw_bytes_sha256=${ref.hash} AND encode(digest(d.raw_bytes,'sha256'),'hex')=${ref.hash}`;
  if(!source)throw new Error('Override evidence bytes unavailable or changed');
  verified.push({...ref});
 }
 return verified.sort((a,b)=>a.evidenceId<b.evidenceId?-1:1);
}

import type {OperationRef} from '../controls/contracts';
import type {ApMaterial} from '../controls/apOperationMaterializer';
import {readControlEntityVersion} from '../controls/operationVersions';
import {riskHash} from '../controls/invoiceRiskQueriesResult';
interface OverrideIntent {id:string;requester_person_id:string;invoice_id:string;expected_match_fingerprint:string;reason:string;evidence_refs:EvidenceRef[];created_at:Date|string}
export async function loadInvoiceMatchOverride(ctx:ControlTx,id:string){
 assertControlTx(ctx);
 const [intent]=await ctx.sql`SELECT * FROM control_invoice_match_override_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid` as OverrideIntent[];
 if(!intent)throw new Error('Owned invoice match override intent required');
 const current=await loadInvoiceMatchCurrent(ctx,intent.invoice_id);
 if(current.match.materialFingerprint!==intent.expected_match_fingerprint)throw new Error('Invoice match override material stale');
 const evidence=await verifyInvoiceMatchEvidence(ctx,intent.invoice_id,intent.evidence_refs);
 const effects=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid
  AND operation='invoice_match.override' AND entity_type='invoice_match_override_intent' AND entity_id=${id}
  ORDER BY committed_at LIMIT 2` as {id:string;result:unknown}[];
 if(effects.length>1)throw new Error('Ambiguous invoice match override effects');
 return{intent,current,evidence,effect:effects[0]??null};
}
export async function materializeInvoiceMatchOverride(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.operation!=='invoice_match.override'||ref.entityType!=='invoice_match_override_intent')throw new Error('Unsupported invoice match override');
 return withInvoiceMatchSourceLocks(ctx,async()=>{
  const state=await loadInvoiceMatchOverride(ctx,ref.entityId),prior=await readControlEntityVersion(ctx,ref);
  const facts={intent:state.intent,invoice:state.current.invoice,amount:state.current.amount,matchFingerprint:state.current.match.materialFingerprint,
   sources:state.current.match.results.map(r=>{const {cached_status:_cache,...row}=r.row;return row;}),evidence:state.evidence,effect:state.effect};
  const parent={entityType:ref.entityType,entityId:ref.entityId,version:prior?.version??1,tracked:prior!==null,facts,fingerprint:riskHash(facts)};
  if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Invoice match override version changed');
  return{supplierId:state.current.invoice.supplier_id,observedSources:[parent],versionBasis:prior?'recorded_with_current_fingerprint':'untracked_current_observation',
   binding:{companyId:ctx.principal.companyId,operation:ref.operation,entityType:ref.entityType,entityId:ref.entityId,entityVersion:parent.version,
    accountingDate:state.current.invoice.invoice_date,amount:state.current.amount,currency:state.current.invoice.currency,beneficiaries:[],
    sourceVersions:[{entityType:parent.entityType,entityId:parent.entityId,version:parent.version,fingerprint:parent.fingerprint}]}};
 });
}
