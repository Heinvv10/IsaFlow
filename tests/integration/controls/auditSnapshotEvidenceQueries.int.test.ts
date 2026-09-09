import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {AuditSnapshotData} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {discoverSnapshotEvidence} from '@/modules/accounting/services/controls/auditSnapshotEvidenceQueries';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
let f:ForensicFixture;
const account=randomUUID(),bank=randomUUID(),journal=randomUUID(),invoice=randomUUID(),customer=randomUUID(),direct=randomUUID(),linked=randomUUID();
function snapshot(records:Array<{source:string;id:string}>):AuditSnapshotData{return{version:1,companyId:f.companyA,snapshotId:randomUUID(),cutoff:'2026-09-09',capturedAt:new Date().toISOString(),
 records:records.map(row=>({...row,version:null,data:{}})),populations:[...new Set(records.map(row=>row.source))].map(source=>({source,count:records.filter(row=>row.source===source).length,excludedCount:0,exclusions:[]})),checks:[],evidence:[],coverage:[],missingSources:[]};}
async function actor<T>(fn:(client:PoolClient)=>Promise<T>,repeatable=true){const client=await pool.connect();
 try{await client.query(repeatable?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:f.u1.id,company_id:f.companyA,role:'authenticated'};await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),f.companyA]);
  return await withControlRequest({client,userId:f.u1.id,companyId:f.companyA,claims},{personId:f.u1.id,companyId:f.companyA,authMethod:'cookie'},()=>fn(client));
 }finally{await client.query('ROLLBACK');client.release();}}
beforeAll(async()=>{
 f=await provisionForensicFixture(config);
 await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(company_id,user_id) DO NOTHING",[f.companyB,f.u1.id]);
 await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic discovery')",[customer,f.companyA]);
 await pool.query("INSERT INTO customer_invoices(id,company_id,client_id,customer_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$3,$1::uuid::text,'2026-09-09',115,$4)",[invoice,f.companyA,customer,f.u1.id]);
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level) VALUES($1,$2,left($1::uuid::text,20),'Synthetic bank','asset','bank','debit',3)",[account,f.companyA]);
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',10,'Synthetic discovery','imported')",[bank,f.companyA,account]);
 await pool.query("INSERT INTO captured_documents(id,company_id,status,file_name,file_type) VALUES($1,$2,'matched','synthetic.pdf','pdf')",[direct,f.companyA]);
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by,source_document_id) VALUES($1,$2,$1::uuid::text,'2026-09-09','draft','manual',$3,$4)",[journal,f.companyA,f.u1.id,direct]);
 await pool.query("INSERT INTO captured_documents(company_id,status,file_name,file_type,matched_bank_tx_id) SELECT $1,'matched','synthetic.pdf','pdf',$2 FROM generate_series(1,103)",[f.companyA,bank]);
 await pool.query("INSERT INTO procurement_documents(id,entity_type,entity_id,file_path,is_active) VALUES($1,'customer_invoice',$2,'accounting/placeholder',true)",[linked,invoice]);
 await pool.query("INSERT INTO document_links(document_id,linked_entity_type,linked_entity_id) VALUES($1,'customer_invoice',$2)",[linked,invoice]);
});
afterAll(()=>pool.end());
it('enumerates passing roots and all pages with exact stable counts without findings',async()=>{
 const saved=snapshot([{source:'bank_transaction',id:bank},{source:'journal_entry',id:journal},{source:'customer_invoice',id:invoice}]);
 await actor(async()=>{
  const result=await discoverSnapshotEvidence(requireControlTx(),saved,{limit:100});
  expect(result.relationCount).toBe(106);expect(result.relations).toHaveLength(100);expect(result.nextCursor).toBeTruthy();
  const rest=await discoverSnapshotEvidence(requireControlTx(),saved,{limit:100,cursor:result.nextCursor!});
  expect(rest.relationCount).toBe(106);expect(rest.relations).toHaveLength(6);expect(rest.nextCursor).toBeNull();
  const all=[...result.relations,...rest.relations];expect(all.some(row=>row.documentId===direct&&row.parentId===journal)).toBe(true);
  expect(all.filter(row=>row.documentId===linked)).toHaveLength(2);
 });
});
it('never grants a foreign original document ownership through an owned crosslink or UUID type collision',async()=>{
 const foreign=randomUUID(),doc=randomUUID(),wrong=randomUUID();
 await pool.query("INSERT INTO credit_notes(id,company_id,type,credit_date,created_by) VALUES($1,$2,'customer','2026-09-09',$3)",[foreign,f.companyB,f.u1.id]);
 await pool.query("INSERT INTO procurement_documents(id,entity_type,entity_id,is_active) VALUES($1,'credit_note',$2,true),($3,'supplier_invoice',$4,true)",[doc,foreign,wrong,invoice]);
 await pool.query("INSERT INTO document_links(document_id,linked_entity_type,linked_entity_id) VALUES($1,'customer_invoice',$3),($2,'customer_invoice',$3)",[doc,wrong,invoice]);
 const result=await actor(()=>discoverSnapshotEvidence(requireControlTx(),snapshot([{source:'customer_invoice',id:invoice}])));
 expect(result.relations.some(row=>row.documentId===doc||row.documentId===wrong)).toBe(false);
});
it('keeps concurrent new evidence outside the original repeatable-read population',async()=>{
 const saved=snapshot([{source:'bank_transaction',id:bank}]),newDoc=randomUUID();
 await actor(async()=>{
  const first=await discoverSnapshotEvidence(requireControlTx(),saved,{limit:1});
  await pool.query("INSERT INTO captured_documents(id,company_id,status,file_name,file_type,matched_bank_tx_id) VALUES($1,$2,'matched','later.pdf','pdf',$3)",[newDoc,f.companyA,bank]);
  const repeated=await discoverSnapshotEvidence(requireControlTx(),saved);expect(repeated.relationCount).toBe(first.relationCount);
  expect(repeated.relations.some(row=>row.documentId===newDoc)).toBe(false);
 });
 expect((await actor(()=>discoverSnapshotEvidence(requireControlTx(),saved))).relations.some(row=>row.documentId===newDoc)).toBe(true);
});
it('refuses foreign identity, current denied permissions, accessors and wrong transaction isolation',async()=>{
 const saved=snapshot([{source:'customer_invoice',id:invoice}]);
 await expect(actor(()=>discoverSnapshotEvidence(requireControlTx(),{...saved,companyId:f.companyB}))).rejects.toThrow();
 await expect(actor(()=>discoverSnapshotEvidence(requireControlTx(),saved),false)).rejects.toThrow(/repeatable/i);
 let calls=0;await expect(actor(()=>discoverSnapshotEvidence(requireControlTx(),saved,{get limit(){calls++;return 1;}}))).rejects.toThrow();expect(calls).toBe(0);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'customers',false)",[f.companyA,f.u1.id]);
 try{await expect(actor(()=>discoverSnapshotEvidence(requireControlTx(),saved))).rejects.toThrow(/permission|denied/i);}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='customers'",[f.companyA,f.u1.id]);}
});
it('retains exact owned Sage and PO/GRN evidence beneath a native supplier invoice root',async()=>{
 const supplier=randomUUID(),native=randomUUID(),sage=randomUUID(),po=randomUUID(),grn=randomUUID(),a=randomUUID(),b=randomUUID(),c=randomUUID();
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic evidence supplier')",[supplier,f.companyA]);
 await pool.query("INSERT INTO purchase_orders(id,company_id,po_number,supplier_id) VALUES($1,$2,$1::uuid::text,$3)",[po,f.companyA,supplier]);
 await pool.query("INSERT INTO goods_received_notes(id,company_id,grn_number,purchase_order_id,received_by) VALUES($1,$2,$1::uuid::text,$3,'synthetic')",[grn,f.companyA,po]);
 await pool.query("INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,purchase_order_id,grn_id,created_by) VALUES($1,$2,$1::uuid::text,$3,'2026-09-09',$4,$5,$6)",[native,f.companyA,supplier,po,grn,f.u1.id]);
 await pool.query("INSERT INTO sage_supplier_invoices(id,company_id,gl_supplier_invoice_id) VALUES($1,$2,$3)",[sage,f.companyA,native]);
 await pool.query("INSERT INTO procurement_documents(id,entity_type,entity_id,is_active) VALUES($1,'supplier_invoice',$2,true),($3,'purchase_order',$4,true),($5,'goods_receipt_note',$6,false)",[a,sage,b,po,c,grn]);
 const result=await actor(()=>discoverSnapshotEvidence(requireControlTx(),snapshot([{source:'supplier_invoice',id:native}])));
 expect(result.relations.map(row=>row.documentId).sort()).toEqual([a,b,c].sort());
 expect(result.relations.every(row=>row.parentSource==='supplier_invoice'&&row.parentId===native)).toBe(true);
});
it('discovers bank attachment identities and binds cursors to the retained root set',async()=>{
 const attachment=randomUUID();await pool.query("INSERT INTO bank_transaction_attachments(id,bank_transaction_id,file_url) VALUES($1,$2,'https://invalid.example/not-fetched')",[attachment,bank]);
 const saved=snapshot([{source:'bank_transaction',id:bank}]);
 await actor(async()=>{
  const first=await discoverSnapshotEvidence(requireControlTx(),saved,{limit:1});
  const all=await discoverSnapshotEvidence(requireControlTx(),saved);
  expect(all.relations.some(row=>row.store==='bank_attachment'&&row.documentId===attachment)).toBe(true);
  await expect(discoverSnapshotEvidence(requireControlTx(),{...saved,snapshotId:randomUUID()},{cursor:first.nextCursor!})).rejects.toThrow(/cursor/i);
  await expect(discoverSnapshotEvidence(requireControlTx(),saved,{limit:1001})).rejects.toThrow();
 });
});
it('refuses a foreign retained root even when its snapshot company field is owned',async()=>{
 const foreign=randomUUID();await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by) VALUES($1,$2,$1::uuid::text,'2026-09-09','draft','manual',$3)",[foreign,f.companyB,f.u1.id]);
 await expect(actor(()=>discoverSnapshotEvidence(requireControlTx(),snapshot([{source:'journal_entry',id:foreign}])))).rejects.toThrow(/foreign|unavailable/i);
});
it('refuses more than100000 actual relations rather than returning a capped complete count',async()=>{
 await actor(async client=>{
  await client.query("INSERT INTO captured_documents(company_id,status,file_name,file_type,matched_bank_tx_id) SELECT $1,'matched','oversize.pdf','pdf',$2 FROM generate_series(1,100001)",[f.companyA,bank]);
  await expect(discoverSnapshotEvidence(requireControlTx(),snapshot([{source:'bank_transaction',id:bank}]),{limit:1})).rejects.toThrow(/resource/i);
 });
},30000);
it('rechecks an empty requested payroll source family instead of deriving authority only from rows',async()=>{
 const saved=snapshot([{source:'customer_invoice',id:invoice}]);saved.populations.push({source:'payroll_run',count:0,excludedCount:0,exclusions:[]});
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[f.companyA,f.u1.id]);
 try{await expect(actor(()=>discoverSnapshotEvidence(requireControlTx(),saved))).rejects.toThrow(/permission|denied/i);}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[f.companyA,f.u1.id]);}
});
for(const alias of ['grn','goods_received_note','goods_receipt_note']){
 it(`admits ${alias} original evidence only in the current owned tenant under actual RLS`,async()=>{
  const docs:string[]=[];
  for(const company of [f.companyA,f.companyB]){
   const supplier=randomUUID(),po=randomUUID(),grn=randomUUID(),doc=randomUUID();docs.push(doc);
   await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic GRN policy supplier')",[supplier,company]);
   await pool.query("INSERT INTO purchase_orders(id,company_id,po_number,supplier_id) VALUES($1,$2,$1::uuid::text,$3)",[po,company,supplier]);
   await pool.query("INSERT INTO goods_received_notes(id,company_id,grn_number,purchase_order_id,received_by) VALUES($1,$2,$1::uuid::text,$3,'synthetic')",[grn,company,po]);
   await pool.query("INSERT INTO procurement_documents(id,entity_type,entity_id,is_active) VALUES($1,$2,$3,true)",[doc,alias,grn]);
  }
  await actor(async client=>{
   // Direct RLS assertion intentionally does not add an application tenant filter.
   const rows=(await client.query('SELECT id FROM procurement_documents WHERE id=ANY($1::uuid[])',[docs])).rows;
   expect(rows.some(row=>row.id===docs[1])).toBe(false);
   expect(rows.map(row=>row.id)).toEqual([docs[0]]);
  });
 });
}
