import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {sageInvoiceSnapshotSources} from '@/modules/accounting/services/controls/auditSnapshotSageInvoiceQueries';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let f:ForensicFixture;
const source=()=>sageInvoiceSnapshotSources[0]!;
async function actor<T>(fn:()=>Promise<T>){const client=await pool.connect();
 try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query('SET LOCAL ROLE app_user');const claims={sub:f.u1.id,company_id:f.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),f.companyA]);
  return await withControlRequest({client,userId:f.u1.id,companyId:f.companyA,claims},{personId:f.u1.id,companyId:f.companyA,authMethod:'cookie'},fn);
 }finally{await client.query('ROLLBACK');client.release();}}
beforeAll(async()=>{f=await provisionForensicFixture(config);});afterAll(()=>pool.end());
it('retains every owned Sage staging row across pages without confusing mirrors with native totals',async()=>{
 await pool.query("INSERT INTO sage_supplier_invoices(company_id,sage_id,invoice_number,invoice_date,total_amount,supplier_name) SELECT $1,'synthetic-'||n,'SAGE-'||n,'2026-09-09',12.34,'Excluded source supplier name' FROM generate_series(1,1002)n",[f.companyA]);
 await pool.query("INSERT INTO sage_supplier_invoices(company_id,invoice_date,total_amount) VALUES($1,'2026-09-10',20),($2,'2026-09-09',999)",[f.companyA,f.companyB]);
 await actor(async()=>{
  expect(source().source).toBe('sage_supplier_invoice');expect(source().family).toBe('ap');
  expect(await source().counts(requireControlTx(),'2026-09-09')).toEqual({count:1002,excludedCount:1});
  const first=await source().page(requireControlTx(),'2026-09-09',null),second=await source().page(requireControlTx(),'2026-09-09',first.at(-1)!.id);
  expect(first).toHaveLength(1000);expect(second).toHaveLength(2);expect(new Set([...first,...second].map(row=>row.id)).size).toBe(1002);
  expect(first[0]!.data).toMatchObject({total_amount:'12.34',currency:null,amount_currency_unavailable:true,supplier_identity_unavailable:true,net_tax_breakdown_unavailable:true});
  expect(first[0]!.version).toBeNull();expect(JSON.stringify([...first,...second])).not.toContain('Excluded source supplier name');
 });
});
it('includes unknown invoice dates and masks a foreign native link even for a dual-company member',async()=>{
 const supplier=randomUUID(),native=randomUUID(),staging=randomUUID();
 await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(company_id,user_id) DO NOTHING",[f.companyB,f.u1.id]);
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Foreign synthetic supplier')",[supplier,f.companyB]);
 await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-09-09',$4)",[native,f.companyB,supplier,f.u1.id]);
 await pool.query("INSERT INTO sage_supplier_invoices(id,company_id,invoice_date,total_amount,gl_supplier_invoice_id) VALUES($1,$2,NULL,NULL,$3)",[staging,f.companyA,native]);
 await actor(async()=>{
  const rows=await source().page(requireControlTx(),'2026-09-09',null);let row=rows.find(row=>row.id===staging);
  if(!row)row=(await source().page(requireControlTx(),'2026-09-09',rows.at(-1)!.id)).find(row=>row.id===staging);
  expect(row!.data).toMatchObject({invoice_date:null,invoice_date_unavailable:true,total_amount:null,total_amount_unavailable:true,gl_supplier_invoice_id:null,native_parent_unavailable:true});
  expect(JSON.stringify(row)).not.toContain(native);
 });
});
it('discovers original procurement bytes for a standalone Sage root without a native mirror',async()=>{
 const staging=randomUUID(),document=randomUUID();
 await pool.query("INSERT INTO sage_supplier_invoices(id,company_id,invoice_date,total_amount) VALUES($1,$2,'2026-09-09',98.76)",[staging,f.companyA]);
 await pool.query("INSERT INTO procurement_documents(id,entity_type,entity_id,is_active) VALUES($1,'supplier_invoice',$2,true)",[document,staging]);
 const {querySnapshotEvidence}=await import('@/modules/accounting/services/controls/auditSnapshotEvidenceQuerySql');
 const result=await actor(()=>querySnapshotEvidence(requireControlTx(),[{source:'sage_supplier_invoice',id:staging}],null,1000));
 expect(result.root_count).toBe(1);expect(result.count).toBe(1);expect(result.rows[0]).toMatchObject({store:'procurement',documentId:document,parentSource:'sage_supplier_invoice',parentId:staging,relation:'document_parent'});
});
it('retains mapped staging mirrors with real entity versions and separate native cutoff classification',async()=>{
 const supplier=randomUUID(),current=randomUUID(),future=randomUUID(),first=randomUUID(),second=randomUUID();
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Owned synthetic supplier')",[supplier,f.companyA]);
 await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-09-09',$4),($5,$2,$3,$5::uuid::text,'2026-09-10',$4)",[current,f.companyA,supplier,f.u1.id,future]);
 await pool.query("INSERT INTO sage_supplier_invoices(id,company_id,invoice_date,total_amount,gl_supplier_invoice_id) VALUES($1,$2,'2026-09-09',100,$3),($4,$2,'2026-09-09',200,$5)",[first,f.companyA,current,second,future]);
 await pool.query("INSERT INTO control_entity_versions(company_id,entity_type,entity_id,version,material_hash) VALUES($1,'sage_supplier_invoice',$2,7,repeat('a',64))",[f.companyA,first]);
 await actor(async()=>{
  const page=await source().page(requireControlTx(),'2026-09-09',null),rest=await source().page(requireControlTx(),'2026-09-09',page.at(-1)!.id),rows=[...page,...rest];
  const owned=rows.find(row=>row.id===first)!,later=rows.find(row=>row.id===second)!;
  expect(String(owned.version)).toBe('7');expect(later.version).toBeNull();
  expect(owned.data).toMatchObject({gl_supplier_invoice_id:current,owned_native_within_cutoff:true,staging_population_not_additive_to_native:true});
  expect(later.data).toMatchObject({gl_supplier_invoice_id:future,owned_native_within_cutoff:false,native_parent_unavailable:false});
 });
});
