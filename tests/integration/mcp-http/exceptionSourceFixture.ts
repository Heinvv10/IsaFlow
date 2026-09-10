import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ForensicFixture} from '../forensic-fixture';
export async function seedExceptionMismatch(pool:Pool,fixture:ForensicFixture){
 const supplier=randomUUID(),po=randomUUID(),line=randomUUID(),invoice=randomUUID(),grn=randomUUID();
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic exception supplier')",[supplier,fixture.companyA]);
 await pool.query(`INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,order_date,status) VALUES($1::uuid,$2,$1::text,$3,'2026-09-09','received')`,[po,fixture.companyA,supplier]);
 await pool.query(`INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Synthetic',10,100,1000)`,[line,po]);
 await pool.query(`INSERT INTO goods_received_notes(id,company_id,grn_number,purchase_order_id,received_date,received_by,status)
 VALUES($1::uuid,$2,$1::text,$3,'2026-09-09',$4,'accepted')`,[grn,fixture.companyA,po,fixture.u1.id]);
 await pool.query(`INSERT INTO grn_items(grn_id,po_item_id,quantity_received,quantity_rejected) VALUES($1,$2,10,0)`,[grn,line]);
 await pool.query(`INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,purchase_order_id,grn_id,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
 VALUES($1::uuid,$2,$1::text,$3,$4,$5,'2026-09-09',1030,0,1030,'ZAR','approved',$6)`,[invoice,fixture.companyA,supplier,po,grn,fixture.u1.id]);
 await pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,po_item_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Synthetic',10,103,1030)`,[invoice,line]);
 await pool.query(`INSERT INTO control_entity_versions(company_id,entity_type,entity_id,version,material_hash) VALUES($1,'supplier_invoice',$2,1,'synthetic')`,[fixture.companyA,invoice]);
 return{invoice,po,line};
}
