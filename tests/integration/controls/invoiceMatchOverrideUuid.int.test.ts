import {capturedStorage} from './capturedEvidenceTestStorage';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {uuidBoundaryFixture,upper} from './uuidBoundaryFixture';
import {queryThreeWayMatch} from '@/modules/accounting/services/ap/threeWayMatchQueryService';
import {prepareInvoiceMatchOverride} from '@/modules/accounting/services/ap/invoiceMatchOverridePreparation';
import {executeInvoiceMatchOverride} from '@/modules/accounting/services/ap/invoiceMatchOverrideEffect';
import {queryInvoiceMatchOverrides} from '@/modules/accounting/services/ap/invoiceMatchOverrideQuery';
let f:Awaited<ReturnType<typeof uuidBoundaryFixture>>;
beforeAll(async()=>{f=await uuidBoundaryFixture();},60000);
afterAll(async()=>{await f?.close();});
type Annotated=Awaited<ReturnType<typeof executeInvoiceMatchOverride>>;
/** One PO line received across a GRN, invoiced at an agreed exception price with same-invoice captured evidence. */
async function prepared(){
 const company=f.f.companyA,supplier=randomUUID(),po=randomUUID(),line=randomUUID(),grn=randomUUID(),invoiceId=randomUUID(),document=randomUUID();
 await f.pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic UUID three-way')",[supplier,company]);
 await f.pool.query("INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,order_date,status) VALUES($1::uuid,$2,$1::text,$3,'2026-09-09','received')",[po,company,supplier]);
 await f.pool.query("INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Synthetic',4,100,400)",[line,po]);
 await f.pool.query(`INSERT INTO goods_received_notes(id,company_id,grn_number,purchase_order_id,received_date,received_by,status)
  VALUES($1::uuid,$2,$1::text,$3,'2026-09-09',$4,'accepted')`,[grn,company,po,f.f.u1.id]);
 await f.pool.query('INSERT INTO grn_items(grn_id,po_item_id,quantity_received,quantity_rejected) VALUES($1,$2,4,0)',[grn,line]);
 await f.pool.query(`INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,purchase_order_id,grn_id,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
  VALUES($1::uuid,$2,$1::text,$3,$4,$5,'2026-09-09',412,0,412,'ZAR','approved',$6)`,[invoiceId,company,supplier,po,grn,f.f.u1.id]);
 await f.pool.query(`INSERT INTO supplier_invoice_items(id,supplier_invoice_id,po_item_id,description,quantity,unit_price,line_total)
  VALUES($1,$2,$3,'Synthetic',4,103,412)`,[randomUUID(),invoiceId,line]);
 const bytes=Buffer.from(`Synthetic UUID signed price exception ${document}`),hash=createHash('sha256').update(bytes).digest('hex');
 await f.pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type,status,matched_invoice_id) VALUES($1,$2,'synthetic.pdf','pdf','matched',$3)",[document,company,invoiceId]);
 await capturedStorage().seed(f.pool,company,document,bytes);
 const match=await f.actor(ctx=>queryThreeWayMatch(ctx,{invoiceId}));
 const saved=await f.actor(ctx=>prepareInvoiceMatchOverride(ctx,{invoiceId,expectedMatchFingerprint:match.materialFingerprint,reason:'Synthetic agreed UUID price exception',
  evidenceRefs:[{store:'captured',evidenceId:document,entityType:'supplier_invoice',entityId:invoiceId,version:null,hash}]}));
 upper(saved.intentId);return{...saved,invoiceId};
}
const execute=(id:string,approvalId?:string)=>f.actor(ctx=>executeInvoiceMatchOverride(ctx,id,approvalId));
async function state(id:string,invoiceId:string){
 const read=await f.actor(ctx=>queryInvoiceMatchOverrides(ctx,invoiceId));
 const approvals=await f.approvals('invoice_match_override_intent',id);
 return{effects:await f.effects('invoice_match_override_intent','invoice_match.override',id),
  reader:read.overrides.map(o=>({intentId:o.intentId,state:o.state,staleReasons:o.staleReasons,version:o.version})),consumed:approvals.filter(a=>a.status==='consumed').length,
  journals:(await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[f.f.companyA])).rows};
}
function expectOneOverride(saved:Awaited<ReturnType<typeof state>>,id:string){
 expect(saved.effects).toHaveLength(1);expect(saved.consumed).toBe(1);expect(saved.journals).toEqual([]);
 // A null version means the retained lineage was not found, so the annotation has no provenance.
 expect(saved.reader).toEqual([{intentId:id,state:'active',staleReasons:[],version:2}]);
}
it.each([false,true])('replays an invoice match override through either UUID case after initial uppercase=%s execution without another approval',async uppercase=>{
 const p=await prepared(),approval=await f.approve(p.operation),caseVariant=upper(p.intentId);
 const first=await execute(uppercase?caseVariant:p.intentId,approval);
 expect(first.intentId).toBe(p.intentId);
 await expect(execute(p.intentId)).resolves.toEqual(first);
 await expect(execute(caseVariant)).resolves.toEqual(first);
 expectOneOverride(await state(p.intentId,p.invoiceId),p.intentId);
});
it('reads an uppercase-first override back as an active annotation with provenance',async()=>{
 const p=await prepared();
 await execute(upper(p.intentId),await f.approve(p.operation));
 expectOneOverride(await state(p.intentId,p.invoiceId),p.intentId);
});
it('cannot annotate one invoice match twice through an independently approved UUID case variant',async()=>{
 const p=await prepared(),first=await execute(p.intentId,await f.approve(p.operation));
 const second=await f.attempt(async()=>execute(upper(p.intentId),await f.approve({...p.operation,entityId:upper(p.intentId)})));
 expectOneOverride(await state(p.intentId,p.invoiceId),p.intentId);
 if(second.value)expect(second.value).toEqual(first);else expect(second.error).toBeInstanceOf(Error);
});
it('serializes concurrently executed independently approved lower and uppercase overrides to one effect',async()=>{
 const p=await prepared(),lowerApproval=await f.approve(p.operation),upperApproval=await f.approve({...p.operation,entityId:upper(p.intentId)});
 const outcomes=await Promise.allSettled([execute(p.intentId,lowerApproval),execute(upper(p.intentId),upperApproval)]);
 expect(outcomes.filter((o):o is PromiseFulfilledResult<Annotated>=>o.status==='fulfilled')).toHaveLength(1);
 expectOneOverride(await state(p.intentId,p.invoiceId),p.intentId);
});
/**
 * The kernel finds a prior effect by the approval's operation_id and by binding_hash, and the first
 * effect bumps the intent's entity version — so a SECOND same-case approval requested afterwards
 * carries a new operation_id and a new binding_hash and misses both. Only the effect's own
 * unexecuted-intent guard stands between that and a second committed annotation.
 */
it('cannot annotate one invoice match twice through a second same-case approval requested after the effect',async()=>{
 const p=await prepared(),first=await execute(p.intentId,await f.approve(p.operation));
 const second=await f.attempt(async()=>execute(p.intentId,await f.approve(p.operation)));
 expectOneOverride(await state(p.intentId,p.invoiceId),p.intentId);
 // The kernel lets it through; the effect's own guard is what refuses.
 expect(second.error instanceof Error?second.error.message:second.value).toBe('Unexecuted override belonging to current requester required');
 expect(first).toBeDefined();
});
/**
 * SYNTHESIZED legacy state, not old-code output: the retained control_entity_versions row is rewritten
 * by hand to the spelling old code would have stored, because no fad0f57f7 baseline seed exists for
 * this operation. A receipt found but a version join missed still reports the annotation dead.
 */
it('reads an override back as active when its retained version row kept a legacy uppercase entity_id',async()=>{
 const p=await prepared();
 await execute(p.intentId,await f.approve(p.operation));
 const forked=async()=>(await f.pool.query(`SELECT entity_id FROM control_entity_versions
  WHERE company_id=$1 AND entity_type='invoice_match_override_intent' AND lower(entity_id)=$2 ORDER BY entity_id`,[f.f.companyA,p.intentId])).rows;
 const rewritten=await f.pool.query(`UPDATE control_entity_versions SET entity_id=upper(entity_id)
  WHERE company_id=$1 AND entity_type='invoice_match_override_intent' AND entity_id=$2 RETURNING entity_id`,[f.f.companyA,p.intentId]);
 expect(rewritten.rows).toEqual([{entity_id:upper(p.intentId)}]);
 expectOneOverride(await state(p.intentId,p.invoiceId),p.intentId);
 await f.attempt(()=>execute(p.intentId));
 expect((await forked()).map(r=>r.entity_id)).toEqual([upper(p.intentId)]);
});
