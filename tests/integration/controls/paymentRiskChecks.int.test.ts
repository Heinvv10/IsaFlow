import {capturedStorage} from './capturedEvidenceTestStorage';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {finalizeRequestTransaction} from '@/lib/auth/transactionFinalization';
import {checkDuplicateInvoices} from '@/modules/accounting/services/controls/duplicateInvoiceChecks';
import {checkPaymentRisks} from '@/modules/accounting/services/controls/paymentRiskChecks';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {duplicateInvoiceChecksTool,paymentRiskChecksTool} from '@/lib/mcp/tools/forensicRiskChecks';
import {seedRiskAttemptHistory} from './paymentRiskAttemptFixture';
import {seedReleaseSupplier} from './paymentReleaseFixture';
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
async function supplier(company=fixture.companyA){const id=randomUUID();await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)',[id,company,'Synthetic risk supplier']);return id;}
async function invoice(supplierId:string,date='2026-09-09',bytes?:Buffer){
 const id=randomUUID(),doc=bytes?randomUUID():null,hash=bytes?createHash('sha256').update(bytes).digest('hex'):null;
 await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
 VALUES($1,$2,$3,$4,$5,1000,150,1150,'ZAR','approved',$6)`,[id,fixture.companyA,supplierId,id,date,fixture.u1.id]);
 if(bytes){await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status,matched_invoice_id) VALUES($1,$2,'synthetic.pdf','pdf','matched',$3)`,[doc,fixture.companyA,id]);
 await capturedStorage().seed(pool,fixture.companyA,doc,bytes);
 await pool.query('UPDATE supplier_invoices SET source_document_id=$1,source_document_hash=$2 WHERE company_id=$3 AND id=$4',[doc,hash,fixture.companyA,id]);}
 return id;
}
it('detects changed references/source-byte reuse but excludes recurring dates and foreign tenant records',async()=>{
 const s=await supplier(),a=await invoice(s,'2026-09-09',Buffer.from('same synthetic invoice')),b=await invoice(s,'2026-09-09',Buffer.from('same synthetic invoice'));
 await pool.query("UPDATE supplier_invoices SET invoice_number=CASE WHEN id=$2 THEN 'INV-001' ELSE 'INV001' END WHERE company_id=$1 AND id=ANY($3::uuid[])",[fixture.companyA,a,[a,b]]);
 await invoice(s,'2026-08-09',Buffer.from('same synthetic invoice'));
 const result=await actor(ctx=>checkDuplicateInvoices(ctx,{limit:20}));expect(result.findingCount).toBe(1);expect(result.amountTotals).toEqual({ZAR:'1150'});
 expect(result.findings[0]).toMatchObject({classification:'confirmed',kind:'reused_invoice_source'});
 expect((await actor(ctx=>checkDuplicateInvoices(ctx,{}),'u3')).populationCount).toBe(0);
 expect((await pool.query('SELECT id FROM control_change_events WHERE company_id=$1',[fixture.companyA])).rowCount).toBe(0);
});
it('counts121 findings and exact totals independently of20-row pages and invalidates changed cursors',async()=>{
 const s=await supplier();
 await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
 SELECT gen_random_uuid(),$1,$2,'SYN-'||g,'2026-09-09',1000,150,1150,'ZAR','approved',$3 FROM generate_series(1,122)g`,[fixture.companyA,s,fixture.u1.id]);
 const first=await actor(ctx=>checkDuplicateInvoices(ctx,{limit:20}));expect(first.populationCount).toBe(122);expect(first.findingCount).toBe(121);expect(first.findings).toHaveLength(20);expect(first.amountTotals).toEqual({ZAR:'139150'});
 const next=await actor(ctx=>checkDuplicateInvoices(ctx,{limit:20,cursor:first.nextCursor!}));expect(next.findingCount).toBe(121);expect(next.findings[0]!.key).not.toBe(first.findings[0]!.key);
 await pool.query("UPDATE supplier_invoices SET invoice_number='changed' WHERE company_id=$1 AND id=$2",[fixture.companyA,first.findings[0]!.entities[0]!.entityId]);
 await expect(actor(ctx=>checkDuplicateInvoices(ctx,{cursor:first.nextCursor!}))).rejects.toThrow('changed');
});
it('detects privately verified shared accounts across suppliers and returns no banking values',async()=>{
 await seedReleaseSupplier(pool,fixture,(person,fn)=>actor(fn,person));await seedReleaseSupplier(pool,fixture,(person,fn)=>actor(fn,person));
 const before=(await pool.query('SELECT count(*)::int AS n FROM control_change_events WHERE company_id=$1',[fixture.companyA])).rows[0].n;
 const result=await actor(ctx=>checkPaymentRisks(ctx,{}));expect(result.findings.some(f=>f.kind==='shared_supplier_bank')).toBe(true);
 expect(JSON.stringify(result)).not.toContain('00987654321');expect(JSON.stringify(result)).not.toContain('001234');
 expect((await actor(ctx=>checkPaymentRisks(ctx,{}),'u3')).findingCount).toBe(0);
 expect((await pool.query('SELECT count(*)::int AS n FROM control_change_events WHERE company_id=$1',[fixture.companyA])).rows[0].n).toBe(before);
});
it('reports missing payment intent evidence and distinguishes distinct invoice allocations',async()=>{
 const s=await supplier(),a=await invoice(s),b=await invoice(s),payments=[randomUUID(),randomUUID(),randomUUID()];
 for(let i=0;i<payments.length;i++){
  await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,created_by)
   VALUES($1,$2,$3,'2026-09-09',1150,'processed',$4)`,[payments[i],fixture.companyA,s,fixture.u1.id]);
  await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1150)',[payments[i],i===1?b:a]);
 }
 const result=await actor(ctx=>checkPaymentRisks(ctx,{}));expect(result.findings.filter(f=>f.kind==='repeated_payment_candidate')).toHaveLength(1);
 expect(result.missingSources).toContain('legacy_payment_intent_or_external_confirmation_unavailable');
});
it('refuses revoked read permission and leaves verified comparison unknown without bank-write authority',async()=>{
 await seedReleaseSupplier(pool,fixture,(person,fn)=>actor(fn,person));
 await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);
 const result=await actor(ctx=>checkPaymentRisks(ctx,{}));expect(result.missingSources).toContain('beneficiary_comparison_authority');expect(result.status).toBe('unknown');
 await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyA,fixture.u1.id]);
 await expect(actor(ctx=>checkDuplicateInvoices(ctx,{}))).rejects.toThrow();
});
it('detects actual activation within48h before payment but does not attribute a later activation',async()=>{
 const s=await seedReleaseSupplier(pool,fixture,(person,fn)=>actor(fn,person)),bill=await invoice(s.supplier);
 const p=randomUUID();await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,processed_at,created_by)
 VALUES($1,$2,$3,'2026-09-09',1150,'processed',clock_timestamp(),$4)`,[p,fixture.companyA,s.supplier,fixture.u1.id]);
 await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1150)',[p,bill]);
 expect((await actor(ctx=>checkPaymentRisks(ctx,{}))).findings.some(f=>f.kind==='recent_beneficiary_change')).toBe(true);
 await pool.query(`UPDATE supplier_payments SET processed_at=(SELECT min(verified_at)-interval '1 second' FROM control_beneficiary_versions
 WHERE company_id=$1 AND entity_id=$2) WHERE company_id=$1 AND id=$3`,[fixture.companyA,s.supplier,p]);
 expect((await actor(ctx=>checkPaymentRisks(ctx,{}))).findings.some(f=>f.kind==='recent_beneficiary_change')).toBe(false);
});
it('reports exact oversized populations as unknown rather than truncating to a passing check',async()=>{
 const s=await supplier();await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
 SELECT gen_random_uuid(),$1,$2,'BOUND-'||g,'2026-09-09',1000,150,1150,'ZAR','approved',$3 FROM generate_series(1,10001)g`,[fixture.companyA,s,fixture.u1.id]);
 const result=await actor(ctx=>checkDuplicateInvoices(ctx,{}));expect(result.populationCount).toBe(10001);expect(result.status).toBe('unknown');
 expect(result.missingSources).toContain('async_scan_required:invoice_population_exceeds_10000');expect(result.findings).toEqual([]);
});
it('does not confirm duplicate source bytes from mutable hash metadata alone',async()=>{
 const s=await supplier(),bytes=Buffer.from('original synthetic bytes');await invoice(s,'2026-09-09',bytes);const changed=await invoice(s,'2026-09-09',bytes);
 const changedDocument=(await pool.query('SELECT source_document_id FROM supplier_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,changed])).rows[0].source_document_id;
 capturedStorage().put(fixture.companyA,changedDocument,Buffer.from('changed synthetic bytes'));
 const result=await actor(ctx=>checkDuplicateInvoices(ctx,{}));expect(result.findings[0]?.classification).toBe('candidate');expect(result.missingSources).toContain('verified_source_file_bytes_unavailable');
});
it('counts owned invoices and payments with foreign supplier parents as unknown, never hidden passes',async()=>{
 const foreign=await supplier(fixture.companyB),bill=randomUUID(),payment=randomUUID();
 await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
 VALUES($1,$2,$3,'FOREIGN-PARENT','2026-09-09',1000,150,1150,'ZAR','approved',$4)`,[bill,fixture.companyA,foreign,fixture.u1.id]);
 await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,created_by)
 VALUES($1,$2,$3,'2026-09-09',1150,'approved',$4)`,[payment,fixture.companyA,foreign,fixture.u1.id]);
 const invoices=await actor(ctx=>checkDuplicateInvoices(ctx,{})),payments=await actor(ctx=>checkPaymentRisks(ctx,{}));
 expect(invoices.populationCount).toBe(1);expect(invoices.status).toBe('unknown');expect(invoices.missingSources).toContain('owned_supplier_parent_unavailable');
 expect(payments.populationCount).toBe(1);expect(payments.status).toBe('unknown');expect(payments.missingSources).toContain('owned_supplier_parent_unavailable');
 expect(JSON.stringify({invoices,payments})).not.toContain(foreign);
});
it('reports unmapped staging imports as unknown and excludes an explicit owned native import mirror',async()=>{
 const stage=randomUUID();await pool.query(`INSERT INTO sage_supplier_invoices(id,company_id,sage_id,invoice_number,supplier_name,invoice_date,total_amount)
 VALUES($1,$2,'SYNTHETIC','IMPORT1','Unmapped supplier','2026-09-09',1150)`,[stage,fixture.companyA]);
 const unknown=await actor(ctx=>checkDuplicateInvoices(ctx,{}));expect(unknown.populationCount).toBe(1);expect(unknown.status).toBe('unknown');
 expect(unknown.missingSources).toContain('unmapped_import_invoice_financial_material_unavailable');
 const s=await supplier(),native=await invoice(s,'2026-09-09',Buffer.from('imported synthetic invoice'));
 await pool.query("UPDATE sage_supplier_invoices SET gl_supplier_invoice_id=$1,migration_status='imported' WHERE company_id=$2 AND id=$3",[native,fixture.companyA,stage]);
 const linked=await actor(ctx=>checkDuplicateInvoices(ctx,{}));expect(linked.populationCount).toBe(2);expect(linked.excludedCount).toBe(1);expect(linked.findingCount).toBe(0);
 expect(linked.missingSources).not.toContain('unmapped_import_invoice_financial_material_unavailable');
});

it('reads repeated immutable preparations through actual release joins without inventing duplicate retries',async()=>{
 const supplier=await seedReleaseSupplier(pool,fixture,(person,fn)=>actor(fn,person));
 const bill=await invoice(supplier.supplier),history=await seedRiskAttemptHistory(pool,fixture,supplier.supplier,bill);
 const first=await history.addAttempt();
 expect((await actor(ctx=>checkPaymentRisks(ctx,{}))).findings.filter(f=>f.kind==='repeated_prepared_release')).toHaveLength(0);
 const second=await history.addAttempt(),result=await actor(ctx=>checkPaymentRisks(ctx,{}));
 const repeated=result.findings.filter(f=>f.kind==='repeated_prepared_release');expect(repeated).toHaveLength(1);
 expect(repeated[0]?.classification).toBe('confirmed');expect(repeated[0]?.entities.map(e=>e.entityId).sort()).toEqual([history.payment,first,second].sort());
 expect((await actor(ctx=>checkPaymentRisks(ctx,{}))).findings.filter(f=>f.kind==='repeated_prepared_release')).toEqual(repeated);
 expect((await actor(ctx=>checkPaymentRisks(ctx,{}),'u3')).findings).toEqual([]);
 expect((await pool.query('SELECT state FROM control_payment_release_outbox WHERE company_id=$1 AND intent_id=ANY($2::uuid[])',[fixture.companyA,[first,second]])).rows).toEqual([{state:'attempting'},{state:'attempting'}]);
});

it('actual detective tool handlers use bound tenant authority and refuse revoked reads',async()=>{
 const s=await supplier();await invoice(s);await invoice(s);
 const transport={companyId:fixture.companyB,userId:fixture.u3.id,scopes:['read:reports'],tokenJti:'synthetic',oauthAppId:null};
 for(const tool of [duplicateInvoiceChecksTool,paymentRiskChecksTool]){
  const answer=await actor(()=>tool.handler({limit:1},transport));
  const dto=JSON.parse(answer.content[0]!.text!);
  expect(dto).toHaveProperty('coverage');expect(dto).toHaveProperty('populationCount');
  expect(JSON.stringify(dto)).not.toContain(fixture.companyB);
  if(tool===duplicateInvoiceChecksTool)expect(dto.populationCount).toBe(2);
 }
 // Revocation is proven by the shared authority fixture below; no transport grant can replace membership.
 await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyA,fixture.u1.id]);
 for(const tool of [duplicateInvoiceChecksTool,paymentRiskChecksTool])await expect(actor(()=>tool.handler({},transport))).rejects.toThrow();
});
