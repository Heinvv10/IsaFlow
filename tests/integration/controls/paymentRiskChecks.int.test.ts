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
 if(bytes){await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status,matched_invoice_id,raw_bytes,raw_bytes_sha256)
 VALUES($1,$2,'synthetic.pdf','pdf','matched',$3,$4,$5)`,[doc,fixture.companyA,id,bytes,hash]);
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
