import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {finalizeRequestTransaction} from '@/lib/auth/transactionFinalization';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {checkThreeWayMatchExceptions} from '@/modules/accounting/services/controls/threeWayMatchChecks';
import {queryThreeWayMatch} from '@/modules/accounting/services/ap/threeWayMatchQueryService';
import {performThreeWayMatch} from '@/modules/accounting/services/ap/supplierInvoiceThreeWayMatch';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});let fixture:ForensicFixture;
beforeAll(()=>{process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');});
beforeEach(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1'){
 const client=await pool.connect(),user=fixture[person];
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  await finalizeRequestTransaction(client,false);return result;
 }catch(error){await finalizeRequestTransaction(client,true);throw error;}finally{client.release();}
}

async function flatCase(){
 const supplier=randomUUID(),po=randomUUID(),line=randomUUID(),invoices=[randomUUID(),randomUUID()];
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic three-way')",[supplier,fixture.companyA]);
 await pool.query(`INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,order_date,status) VALUES($1::uuid,$2,$1::text,$3,'2026-09-09','received')`,[po,fixture.companyA,supplier]);
 await pool.query(`INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Synthetic',10,100,1000)`,[line,po]);
 for(const [index,qty] of [4,6].entries()){
  const grn=randomUUID();await pool.query(`INSERT INTO goods_received_notes(id,company_id,grn_number,purchase_order_id,received_date,received_by,status)
   VALUES($1::uuid,$2,$1::text,$3,'2026-09-09',$4,'accepted')`,[grn,fixture.companyA,po,fixture.u1.id]);
  await pool.query(`INSERT INTO grn_items(grn_id,po_item_id,quantity_received,quantity_rejected) VALUES($1,$2,$3,$4)`,[grn,line,qty,index===0?2:0]);
  await pool.query(`INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,purchase_order_id,grn_id,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
   VALUES($1::uuid,$2,$1::text,$3,$4,$5,'2026-09-09',$6,0,$6,'ZAR','approved',$7)`,[invoices[index],fixture.companyA,supplier,po,grn,qty*100,fixture.u1.id]);
  await pool.query(`INSERT INTO supplier_invoice_items(id,supplier_invoice_id,po_item_id,description,quantity,unit_price,line_total)
   VALUES($1,$2,$3,'Synthetic',$4,100,$5)`,[randomUUID(),invoices[index],line,qty,qty*100]);
 }
 return{supplier,po,line,invoices};
}
it('uses cumulative accepted receipt and invoice math in the existing mutating adapter',async()=>{
 const data=await flatCase();const result=await actor(()=>performThreeWayMatch(fixture.companyA,data.invoices[0]!));
 expect(result.matchStatus).toBe('fully_matched');
 expect(result.itemResults[0]?.match.quantityMatch).toBe(true);expect(result.itemResults[0]?.match.grnMatch).toBe(true);
});

it('shares exact price boundaries and cumulative quantity exceptions across both paths',async()=>{
 const data=await flatCase();
 await pool.query('UPDATE supplier_invoice_items SET unit_price=103 WHERE supplier_invoice_id=$1',[data.invoices[0]]);
 const report=await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}));expect(report.findingCount).toBe(1);
 const written=await actor(()=>performThreeWayMatch(fixture.companyA,data.invoices[0]!));expect(written.itemResults[0]?.match.priceMatch).toBe(false);
 await pool.query('UPDATE supplier_invoice_items SET unit_price=102 WHERE supplier_invoice_id=$1',[data.invoices[0]]);
 expect((await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}))).findingCount).toBe(0);
 await pool.query('UPDATE supplier_invoice_items SET quantity=7 WHERE supplier_invoice_id=$1',[data.invoices[1]]);
 expect((await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}))).findingCount).toBe(2);
});
it('reports missing receipt evidence without treating cached quantities as proof',async()=>{
 const data=await flatCase();await pool.query('DELETE FROM goods_received_notes WHERE company_id=$1 AND purchase_order_id=$2',[fixture.companyA,data.po]);
 const result=await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}));expect(result.status).toBe('unknown');
 expect(result.missingSources).toContain('accepted_receipt_evidence_unavailable');
});
it('keeps full 121-finding totals with 20-row pages and invalidates changed tolerance material',async()=>{
 const data=await flatCase();await pool.query('UPDATE supplier_invoice_items SET unit_price=103,line_total=quantity*103 WHERE supplier_invoice_id=ANY($1::uuid[])',[data.invoices]);
 await pool.query(`WITH added AS (INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total)
 SELECT gen_random_uuid(),$1,'Additional synthetic',1,100,100 FROM generate_series(1,119) RETURNING id)
 INSERT INTO supplier_invoice_items(id,supplier_invoice_id,po_item_id,description,quantity,unit_price,line_total)
 SELECT gen_random_uuid(),$2,id,'Additional synthetic',1,103,103 FROM added`,[data.po,data.invoices[0]]);
 const result=await actor(ctx=>checkThreeWayMatchExceptions(ctx,{limit:20}));expect(result.findingCount).toBe(121);expect(result.findings).toHaveLength(20);expect(result.amountTotals.ZAR).toBe('13287');
 const next=await actor(ctx=>checkThreeWayMatchExceptions(ctx,{cursor:result.nextCursor!,limit:20}));expect(next.findingCount).toBe(121);
 await pool.query(`INSERT INTO supplier_coding_rules(company_id,supplier_id,qty_tolerance_pct,price_tolerance_pct) VALUES($1,$2,2,3)`,[fixture.companyA,data.supplier]);
 await expect(actor(ctx=>checkThreeWayMatchExceptions(ctx,{cursor:result.nextCursor!,limit:20}))).rejects.toThrow('changed');
});
it('refuses revoked access and excludes another tenant without exposing its identifiers',async()=>{
 const data=await flatCase();expect((await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}),'u3')).populationCount).toBe(0);
 await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyA,fixture.u1.id]);
 await expect(actor(ctx=>queryThreeWayMatch(ctx,{invoiceId:data.invoices[0]!}))).rejects.toThrow();
});
it('keeps supplier-order prices usable while refusing to invent GRN provenance from quantity caches',async()=>{
 const supplier=randomUUID(),po=randomUUID(),line=randomUUID(),invoice=randomUUID();
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic supplier-family')",[supplier,fixture.companyA]);
 await pool.query(`INSERT INTO supplier_purchase_orders(id,company_id,order_number,supplier_id,order_date,status)
 VALUES($1::uuid,$2,$1::text,$3,'2026-09-09','sent')`,[po,fixture.companyA,supplier]);
 await pool.query(`INSERT INTO supplier_purchase_order_items(id,purchase_order_id,description,quantity,unit_price,line_total,qty_received)
 VALUES($1,$2,'Synthetic',10,100,1000,10)`,[line,po]);
 await pool.query(`INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,purchase_order_id,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
 VALUES($1::uuid,$2,$1::text,$3,$4,'2026-09-09',1030,0,1030,'ZAR','approved',$5)`,[invoice,fixture.companyA,supplier,po,fixture.u1.id]);
 await pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,po_item_id,description,quantity,unit_price,line_total)
 VALUES($1,$2,'Synthetic',10,103,1030)`,[invoice,line]);
 const result=await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}));expect(result.findingCount).toBe(1);
 expect(result.missingSources).toContain('supplier_po_accepted_receipt_provenance_unavailable');
 expect(result.findings[0]?.message).toContain('price');
});
it('keeps rejected-only receipts out of accepted capacity and excludes deleted invoices',async()=>{
 const data=await flatCase();await pool.query("UPDATE goods_received_notes SET status='rejected' WHERE company_id=$1 AND purchase_order_id=$2",[fixture.companyA,data.po]);
 const rejected=await actor(ctx=>queryThreeWayMatch(ctx,{}));expect(rejected.results.every(r=>r.match?.grnMatch===false)).toBe(true);
 await pool.query("UPDATE goods_received_notes SET status='accepted' WHERE company_id=$1 AND purchase_order_id=$2",[fixture.companyA,data.po]);
 await pool.query('UPDATE supplier_invoice_items SET unit_price=999 WHERE supplier_invoice_id=$1',[data.invoices[0]]);
 await pool.query('UPDATE supplier_invoices SET deleted_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[fixture.companyA,data.invoices[0]]);
 const result=await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}));expect(result.findingCount).toBe(0);expect(result.excludedCount).toBe(1);
});
it('retains owned invoices with foreign PO parents as unknown without exposing the foreign PO',async()=>{
 const data=await flatCase(),foreign=randomUUID(),otherSupplier=randomUUID();
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Foreign synthetic')",[otherSupplier,fixture.companyB]);
 await pool.query(`INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,status) VALUES($1::uuid,$2,$1::text,$3,'approved')`,[foreign,fixture.companyB,otherSupplier]);
 await pool.query('UPDATE supplier_invoices SET purchase_order_id=$1 WHERE company_id=$2 AND id=ANY($3::uuid[])',[foreign,fixture.companyA,data.invoices]);
 const result=await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}));expect(result.populationCount).toBe(2);expect(result.status).toBe('unknown');
 expect(result.missingSources).toContain('owned_purchase_order_line_material_unavailable');expect(JSON.stringify(result)).not.toContain(foreign);
});
it('rolls back every match cache write when the caller catches a later cache failure and commits',async()=>{
 const data=await flatCase(),constraint=`synthetic_match_${randomUUID().replaceAll('-','')}`;
 // A company-owned fixture row alone is rejected; no production data or external service is used.
 await pool.query(`ALTER TABLE supplier_invoices ADD CONSTRAINT ${constraint} CHECK(id <> '${data.invoices[0]}'::uuid OR match_status <> 'fully_matched') NOT VALID`);
 try{
  await actor(async()=>{try{await performThreeWayMatch(fixture.companyA,data.invoices[0]!);}catch(error){expect(String(error)).toContain(constraint);}});
  expect((await pool.query('SELECT match_computed_at FROM supplier_invoice_items WHERE supplier_invoice_id=$1',[data.invoices[0]])).rows[0].match_computed_at).toBeNull();
 }finally{await pool.query(`ALTER TABLE supplier_invoices DROP CONSTRAINT ${constraint}`);}
});
it('reports unresolved receipt evidence even alongside enough accepted receipts',async()=>{
 const data=await flatCase(),grn=randomUUID();
 await pool.query(`INSERT INTO goods_received_notes(id,company_id,grn_number,purchase_order_id,received_date,received_by,status)
 VALUES($1::uuid,$2,$1::text,$3,'2026-09-09',$4,'draft')`,[grn,fixture.companyA,data.po,fixture.u1.id]);
 await pool.query(`INSERT INTO grn_items(grn_id,po_item_id,quantity_received,quality_status) VALUES($1,$2,2,'pending')`,[grn,data.line]);
 const result=await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}));
 expect(result.missingSources).toContain('unresolved_receipt_acceptance_evidence');expect(result.status).toBe('unknown');
 const cached=await actor(()=>performThreeWayMatch(fixture.companyA,data.invoices[0]!));
 expect(cached.matchStatus).not.toBe('fully_matched');
});
