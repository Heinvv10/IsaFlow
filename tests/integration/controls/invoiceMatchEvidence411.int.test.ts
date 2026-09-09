import {verifyInvoiceMatchEvidence} from '@/modules/accounting/services/ap/invoiceMatchOverrideMaterial';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {capturedEvidenceHttpFixture} from './capturedEvidenceHttpFixture';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture,storage:Awaited<ReturnType<typeof capturedEvidenceHttpFixture>>;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);storage=await capturedEvidenceHttpFixture();});
afterAll(async()=>{try{await storage.close();}finally{await pool.end();}});
async function source<T>(fn:(ctx:ControlTx,data:{document:string;invoice:string;supplier:string;hash:string})=>Promise<T>){
 const client=await pool.connect(),document=randomUUID(),invoice=randomUUID(),supplier=randomUUID(),account=randomUUID();
 try{
  await client.query('BEGIN');await client.query('ALTER TABLE public.captured_documents DROP COLUMN IF EXISTS raw_bytes');
  await client.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic supplier')",[supplier,fixture.companyA]);
  await client.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-09-09',$4)",[invoice,fixture.companyA,supplier,fixture.u1.id]);
  await client.query("INSERT INTO captured_documents(id,company_id,status,file_name,file_type,matched_invoice_id) VALUES($1,$2,'matched','synthetic.pdf','pdf',$3)",[document,fixture.companyA,invoice]);
  const hash=await storage.seed(client,fixture.companyA,document,Buffer.from('Actual local object bytes'));
  await client.query('UPDATE supplier_invoices SET source_document_id=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice,document]);
  await client.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic bank','asset','bank','debit',3,true)",[account,fixture.companyA]);
  await client.query("INSERT INTO bank_statement_imports(id,company_id,bank_account_id,source_document_id,period_start,period_end,row_count,opening_balance,closing_balance,status) VALUES($1,$2,$3,$4,'2026-09-01','2026-09-09',0,0,0,'committed')",[randomUUID(),fixture.companyA,account,document]);
  await client.query('SET LOCAL ROLE app_user');
  const claims={sub:fixture.u1.id,company_id:fixture.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  return await withControlRequest({client,userId:fixture.u1.id,companyId:fixture.companyA,claims},
   {personId:fixture.u1.id,companyId:fixture.companyA,authMethod:'cookie'},()=>fn(requireControlTx(),{document,invoice,supplier,hash}));
 }finally{await client.query('ROLLBACK');client.release();}
}
it('verifies actual HTTP invoice evidence after migration411 drops inline bytes',()=>source(async(ctx,data)=>{
 const refs=[{store:'captured' as const,evidenceId:data.document,entityType:'supplier_invoice',entityId:data.invoice,version:null,hash:data.hash}];
 expect(await verifyInvoiceMatchEvidence(ctx,data.invoice,refs)).toEqual(refs);
}));
it('rejects changed actual object bytes under unchanged document metadata',()=>source(async(ctx,data)=>{
 storage.put(fixture.companyA,data.document,Buffer.from('Changed local object bytes'));
 await expect(verifyInvoiceMatchEvidence(ctx,data.invoice,[{store:'captured',evidenceId:data.document,entityType:'supplier_invoice',entityId:data.invoice,version:null,hash:data.hash}])).rejects.toThrow('changed');
}));
