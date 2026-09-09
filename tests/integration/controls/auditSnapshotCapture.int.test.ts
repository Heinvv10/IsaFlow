import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {captureAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotCapture';
import {prepareBankStatementAttestation} from '@/modules/accounting/services/controls/bankStatementAttestationPreparation';
import {recordCommittedChange} from '@/modules/accounting/services/controls/changeEventService';
import {compareSealedAuditSnapshots} from '@/modules/accounting/services/controls/auditSnapshotCompare';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
let fixture:ForensicFixture,debit:string,credit:string;
process.env.ENCRYPTION_KEY='b'.repeat(64);
process.env.CONTROL_SNAPSHOT_SIGNING_KEY='synthetic-snapshot-key-kept-outside-database';
const request={cutoff:'2026-09-09',sources:['journals'] as const,checks:[],idempotencyKey:'capture'};
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,isolation='REPEATABLE READ',person:'u1'|'u3'='u1',seed?:(client:PoolClient)=>Promise<void>){
 const client=await pool.connect(),user=fixture[person];try{
  await client.query(isolation==='REPEATABLE READ'?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');
  if(seed)await seed(client);
  await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const value=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
   {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  await client.query('COMMIT');return value;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
function capture(ctx:ControlTx){return captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:[...request.sources]}});}
beforeEach(async()=>{
 fixture=await provisionForensicFixture(config);debit=randomUUID();credit=randomUUID();
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level)
 VALUES($1::uuid,$3,left($1::text,12),'Synthetic debit','asset','debit',3),($2::uuid,$3,left($2::text,12),'Synthetic credit','liability','credit',3)`,[debit,credit,fixture.companyA]);
});
afterAll(()=>pool.end());
async function journal(date='2026-09-09'){
 const id=randomUUID();await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,entry_number,source,status,created_by)
 VALUES($1::uuid,$2,$3,left($1::text,20),'manual','draft',$4)`,[id,fixture.companyA,date,fixture.u1.id]);
 await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
 VALUES($1,$2,$3,100,0),($1,$2,$4,0,100)`,[id,fixture.companyA,debit,credit]);return id;
}
it('refuses READ COMMITTED instead of publishing a potentially mixed capture',async()=>{
 await expect(actor(capture,'READ COMMITTED')).rejects.toThrow(/repeatable read/i);
});
it('materializes the complete owned journal population through multiple keyset pages',async()=>{
 const ids=Array.from({length:501},()=>randomUUID());
 await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,entry_number,source,status,created_by)
 SELECT id,$2,'2026-09-09',left(id::text,20),'manual','draft',$3 FROM unnest($1::uuid[]) id`,[ids,fixture.companyA,fixture.u1.id]);
 await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
 SELECT id,$2::uuid,$3::uuid,100,0 FROM unnest($1::uuid[]) id UNION ALL SELECT id,$2::uuid,$4::uuid,0,100 FROM unnest($1::uuid[]) id`,[ids,fixture.companyA,debit,credit]);
 await journal('2026-09-10');
 const result=await actor(capture);
 expect(result.records.filter(r=>r.source==='journal_entry')).toHaveLength(501);
 const lines=result.records.filter(r=>r.source==='journal_line');expect(lines).toHaveLength(1002);
 expect(lines.reduce((sum,r)=>sum+Number(r.data.debit),0)).toBe(50100);
 expect(result.populations.find(p=>p.source==='journal_entry')).toMatchObject({count:501,excludedCount:1});
 expect(result.populations.find(p=>p.source==='journal_line')).toMatchObject({count:1002,excludedCount:2});
 expect((await actor(capture,'REPEATABLE READ','u3')).records).toEqual([]);
 expect(()=>sealAuditSnapshot(result)).not.toThrow();
});
it('retains an old capture after a later backdated addition',async()=>{
 await journal();const first=await actor(capture),sealed=sealAuditSnapshot(first);
 await journal('2026-08-31');const second=await actor(capture);
 expect(first.records).toHaveLength(3);expect(second.records).toHaveLength(6);
 expect(sealAuditSnapshot(first)).toEqual(sealed);
 const diff=compareSealedAuditSnapshots(fixture.companyA,{id:first.snapshotId,sealed},{id:second.snapshotId,sealed:sealAuditSnapshot(second)});
 expect(diff.records.added).toHaveLength(3);expect(diff.records.changed).toEqual([]);expect(diff.populationChanged).toBe(true);
});
it('captures every requested source family and seals actual detective results without secret fields',async()=>{
 const employee=randomUUID(),run=randomUUID();
 await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,$3,'Private name','Synthetic','2020-01-01','active')",[employee,fixture.companyA,employee.slice(0,12)]);
 await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_net,employee_count) VALUES($1,$2,8,2026,'draft',100,100,1)",[run,fixture.companyA]);
 await pool.query("INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,net_pay,component_breakdown) VALUES($1,$2,100,100,$3::jsonb)",[run,employee,JSON.stringify([{private:'Never retain this'}])]);
 await journal();
 const result=await actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['journals','ar','ap','bank','payroll'],
  checks:['duplicate_invoice_checks','payment_risk_checks','three_way_match_exceptions','journal_risk_checks','bank_statement_completeness','payroll_control_checks']}}));
 expect(result.populations).toHaveLength(15);expect(result.checks).toHaveLength(6);
 expect(result.records.find(r=>r.source==='payroll_run_line')?.data).toMatchObject({employee_id:employee,gross_pay:'100.00'});
 expect(JSON.stringify(result)).not.toMatch(/Private name|Never retain this|component_breakdown/);
 expect(result.missingSources).toContain('retained_evidence_not_attached');expect(()=>sealAuditSnapshot(result)).not.toThrow();
});
it('preserves one database state when another transaction updates headers and lines during capture transaction',async()=>{
 const id=await journal();
 const result=await actor(async ctx=>{
  await ctx.sql`SELECT id FROM gl_journal_entries WHERE company_id=${fixture.companyA}::uuid AND id=${id}::uuid`;
  const other=await pool.connect();try{
   await other.query('BEGIN');await other.query("UPDATE gl_journal_entries SET status='posted' WHERE company_id=$1 AND id=$2",[fixture.companyA,id]);
   await other.query('UPDATE gl_journal_lines SET debit=debit*2,credit=credit*2 WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,id]);
   await other.query('COMMIT');
  }catch(error){await other.query('ROLLBACK');throw error;}finally{other.release();}
  return capture(ctx);
 });
 expect(result.records.find(r=>r.source==='journal_entry')?.data.status).toBe('draft');
 expect(result.records.filter(r=>r.source==='journal_line').reduce((sum,r)=>sum+Number(r.data.debit),0)).toBe(100);
 const later=await actor(capture);expect(later.records.find(r=>r.source==='journal_entry')?.data.status).toBe('posted');
 expect(later.records.filter(r=>r.source==='journal_line').reduce((sum,r)=>sum+Number(r.data.debit),0)).toBe(200);
 const diff=compareSealedAuditSnapshots(fixture.companyA,{id:result.snapshotId,sealed:sealAuditSnapshot(result)},{id:later.snapshotId,sealed:sealAuditSnapshot(later)});
 expect(diff.records.changed).toHaveLength(3);expect(diff.records.added).toEqual([]);
});
it('refuses a current module read revocation before materializing requested payroll',async()=>{
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[fixture.companyA,fixture.u1.id]);
 await expect(actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['payroll']}}))).rejects.toThrow(/permission/i);
});
it('masks a corrupt foreign period reference even for a person who belongs to both tenants',async()=>{
 const period=randomUUID(),id=await journal();
 await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[fixture.companyB,fixture.u1.id]);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Foreign private period',1,2026,'2026-01-01','2026-12-31','open')",[period,fixture.companyB]);
 await pool.query('UPDATE gl_journal_entries SET fiscal_period_id=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,id,period]);
 const result=await actor(capture);
 expect(result.records.find(r=>r.source==='journal_entry')?.data.fiscal_period_id).toBeNull();
 expect(JSON.stringify(result)).not.toContain(period);expect(result.missingSources).toContain('journal_entry:period_parent_unavailable');
});
it('materializes actual AR/AP children and bank source amounts with owned evidence references',async()=>{
 const customer=randomUUID(),supplier=randomUUID(),arInvoice=randomUUID(),apInvoice=randomUUID(),arPayment=randomUUID(),apPayment=randomUUID();
 await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Private customer')",[customer,fixture.companyA]);
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Private supplier')",[supplier,fixture.companyA]);
 await pool.query("INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$3,$1::uuid::text,'2026-09-09',100,$4)",[arInvoice,fixture.companyA,customer,fixture.u1.id]);
 await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-09-09',100,$4)",[apInvoice,fixture.companyA,supplier,fixture.u1.id]);
 await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount) VALUES($1,'Private description',1,100,100)",[arInvoice]);
 await pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total) VALUES($1,'Private description',1,100,100)",[apInvoice]);
 await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,created_by) VALUES($1,$2,$3,'2026-09-09',100,$4)",[arPayment,fixture.companyA,customer,fixture.u1.id]);
 await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,created_by) VALUES($1,$2,$3,'2026-09-09',100,$4)",[apPayment,fixture.companyA,supplier,fixture.u1.id]);
 await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,100)',[arPayment,arInvoice]);
 await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,100)',[apPayment,apInvoice]);
 await pool.query("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,status) VALUES($1,$2,'2026-09-09',100,'imported')",[fixture.companyA,debit]);
 const document=randomUUID(),bytes=Buffer.from('Synthetic retained statement'),hash=createHash('sha256').update(bytes).digest('hex');
 await pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type,status,raw_bytes,raw_bytes_sha256) VALUES($1,$2,'statement.pdf','pdf','matched',$3,$4)",[document,fixture.companyA,bytes,hash]);
 await pool.query("INSERT INTO bank_statement_imports(company_id,bank_account_id,source_document_id,period_start,period_end,opening_balance,closing_balance,row_count,status,created_by) VALUES($1,$2,$3,'2026-09-01','2026-09-09',0,100,1,'committed',$4)",[fixture.companyA,debit,document,fixture.u1.id]);
 const result=await actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['ar','ap','bank']}}));
 expect(result.populations.filter(p=>p.source!=='bank_statement_attestation_intent').every(p=>p.count===1)).toBe(true);expect(result.records).toHaveLength(10);
 expect(result.coverage).toContain('population_total:supplier_payment_allocation:amount_allocated:ZAR:100');
 expect(result.coverage).toContain('population_total:bank_transaction:amount:ZAR:100');
 expect(JSON.stringify(result)).not.toMatch(/Private customer|Private supplier|Private description/);
 expect(()=>sealAuditSnapshot(result)).not.toThrow();
});
it('restores a stricter caller statement timeout after successful capture',async()=>{
 await actor(async ctx=>{
  await ctx.sql`SELECT set_config('statement_timeout','5s',true)`;
  await capture(ctx);
  const [settings]=await ctx.sql`SELECT current_setting('statement_timeout') AS timeout` as Array<{timeout:string}>;
  expect(settings?.timeout).toBe('5s');
 });
});
it('refuses an actual source population beyond100000 before returning partial records',async()=>{
 await expect(actor(capture,'REPEATABLE READ','u1',async client=>{
  await client.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,entry_number,source,status,created_by)
   SELECT id,$1,'2026-09-09',left(id::text,20),'manual','draft',$2 FROM(SELECT gen_random_uuid() AS id FROM generate_series(1,100001)) generated`,[fixture.companyA,fixture.u1.id]);
 })).rejects.toThrow(/population resource limit/i);
 expect((await pool.query('SELECT COUNT(*)::int AS count FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows[0].count).toBe(0);
});
it('keeps source monetary totals separate by currency',async()=>{
 const supplier=randomUUID();await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic currencies')",[supplier,fixture.companyA]);
 for(const currency of ['ZAR','USD'])await pool.query("INSERT INTO supplier_invoices(company_id,supplier_id,invoice_number,invoice_date,total_amount,currency,created_by) VALUES($1,$2,$3,'2026-09-09',100,$4,$5)",[fixture.companyA,supplier,randomUUID(),currency,fixture.u1.id]);
 const result=await actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['ap']}}));
 expect(result.coverage).toContain('population_total:supplier_invoice:total_amount:ZAR:100');
 expect(result.coverage).toContain('population_total:supplier_invoice:total_amount:USD:100');
});
it('retains the owned statement attestation source separately from its execution status',async()=>{
 const document=randomUUID(),bytes=Buffer.from('Synthetic source statement'),hash=createHash('sha256').update(bytes).digest('hex');
 await pool.query("UPDATE gl_accounts SET account_subtype='bank' WHERE company_id=$1 AND id=$2",[fixture.companyA,debit]);
 await pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type,status,raw_bytes,raw_bytes_sha256) VALUES($1,$2,'statement.pdf','pdf','matched',$3,$4)",[document,fixture.companyA,bytes,hash]);
 const intent=await actor(ctx=>prepareBankStatementAttestation(ctx,{bankAccountId:debit,sourceDocumentId:document,expectedSourceHash:hash,
  periodStart:'2026-09-01',periodEnd:'2026-09-09',sourceCount:1,openingBalance:'0',closingBalance:'100',currency:'ZAR'}));
 const result=await actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['bank']}}));
 expect(result.populations.find(p=>p.source==='bank_statement_attestation_intent')?.count).toBe(1);
 expect(result.records.find(r=>r.id===intent.intentId)?.data).toMatchObject({source_document_id:document,expected_source_hash:hash,execution_effect_id:null});
 expect(result.evidence).toEqual([]);expect(result.missingSources).toContain('retained_evidence_not_attached');
});
it('retains an actual bigint entity version in a sealable canonical numeric representation',async()=>{
 const id=await journal();
 await actor(ctx=>recordCommittedChange(ctx,{entityType:'journal_entry',entityId:id,previousVersion:null,newVersion:1,action:'baseline_observed',
  accountingDate:'2026-09-09',before:null,after:{status:'draft'},bindingHash:null,protectedEvidenceRef:null}));
 const result=await actor(capture);expect(result.records.find(r=>r.id===id)?.version).toBe(1);
 expect(()=>sealAuditSnapshot(result)).not.toThrow();
});
it('detects a changed payroll component payload without retaining its sensitive values',async()=>{
 const employee=randomUUID(),run=randomUUID();
 await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,$3,'Private','Synthetic','2020-01-01','active')",[employee,fixture.companyA,employee.slice(0,12)]);
 await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,8,2026,'draft')",[run,fixture.companyA]);
 await pool.query("INSERT INTO payroll_run_lines(run_id,employee_id,component_breakdown) VALUES($1,$2,$3::jsonb)",[run,employee,JSON.stringify([{componentId:'private-component',amount:100,privateNote:'Sensitive salary note'}])]);
 const runCapture=()=>actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['payroll']}}));
 const old=await runCapture(),before=old.records.find(r=>r.source==='payroll_run_line')!;
 expect(before.data.component_fingerprint).toMatch(/^[a-f0-9]{64}$/);
 await pool.query('UPDATE payroll_run_lines SET component_breakdown=$2::jsonb WHERE run_id=$1',[run,JSON.stringify([{componentId:'private-component',amount:110,privateNote:'Sensitive salary note'}])]);
 const after=(await runCapture()).records.find(r=>r.source==='payroll_run_line')!;
 expect(after.data.component_fingerprint).not.toBe(before.data.component_fingerprint);
 expect(JSON.stringify(old)).not.toMatch(/private-component|Sensitive salary note/);
});
it('retains every actual detective finding page and its complete totals',async()=>{
 const ids=Array.from({length:101},()=>randomUUID());
 await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,entry_number,source,status,created_by,posted_at)
 SELECT id,$2,'2026-08-31',left(id::text,20),'manual','posted',$3,'2026-09-09T20:00:00Z' FROM unnest($1::uuid[]) id`,[ids,fixture.companyA,fixture.u1.id]);
 await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
 SELECT id,$2::uuid,$3::uuid,100,0 FROM unnest($1::uuid[]) id UNION ALL SELECT id,$2::uuid,$4::uuid,0,100 FROM unnest($1::uuid[]) id`,[ids,fixture.companyA,debit,credit]);
 const result=await actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['journals'],checks:['journal_risk_checks']}}));
 expect(result.checks[0]).toMatchObject({populationCount:101,findingCount:101,nextCursor:null,amountTotals:{ZAR:'10100'}});
 expect(result.checks[0]?.findings).toHaveLength(101);expect(()=>sealAuditSnapshot(result)).not.toThrow();
});
it('rejects accessor request substitution without invoking getters',async()=>{
 let reads=0;const input={snapshotId:randomUUID(),get request(){reads++;return{...request,sources:['journals'] as const};}};
 await expect(actor(ctx=>captureAuditSnapshot(ctx,input as never))).rejects.toThrow(/unsupported evidence property/i);expect(reads).toBe(0);
});
it('uses the shared payroll accounting cutoff including an explicit earlier run date',async()=>{
 const run=randomUUID();await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,run_date,status) VALUES($1,$2,9,2026,'2026-09-05','draft')",[run,fixture.companyA]);
 const result=await actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['payroll'],checks:['payroll_control_checks']}}));
 expect(result.populations.find(p=>p.source==='payroll_run')?.count).toBe(1);
 expect(result.checks[0]?.populationCount).toBe(1);expect(result.records.find(r=>r.id===run)).toBeDefined();
});
it('normalizes actual PostgreSQL detector observation timestamps for retained sealing',async()=>{
 const supplier=randomUUID();await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic timestamp')",[supplier,fixture.companyA]);
 await pool.query("INSERT INTO supplier_invoices(company_id,supplier_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,'2026-09-09',100,$4)",[fixture.companyA,supplier,randomUUID(),fixture.u1.id]);
 const result=await actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['ap'],checks:['duplicate_invoice_checks']}}));
 expect(result.checks[0]?.populationCount).toBe(1);expect(()=>sealAuditSnapshot(result)).not.toThrow();
});
it('detects changed owned account classifications with unchanged journal and invoice line account IDs',async()=>{
 await journal();const customer=randomUUID(),supplier=randomUUID(),ar=randomUUID(),ap=randomUUID();
 await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Private classification customer')",[customer,fixture.companyA]);
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Private classification supplier')",[supplier,fixture.companyA]);
 await pool.query("INSERT INTO customer_invoices(id,company_id,customer_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-09-09',100,$4)",[ar,fixture.companyA,customer,fixture.u1.id]);
 await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-09-09',100,$4)",[ap,fixture.companyA,supplier,fixture.u1.id]);
 await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,gl_account_id) VALUES($1,'Private line',1,100,100,$2)",[ar,debit]);
 await pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,gl_account_id) VALUES($1,'Private line',1,100,100,$2)",[ap,debit]);
 const get=()=>actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:['journals','ar','ap']}}));
 const before=await get(),sealed=sealAuditSnapshot(before);
 await pool.query("UPDATE gl_accounts SET account_code='CLASSIFIED-100',account_type='expense',account_subtype='operating',default_vat_code='STANDARD' WHERE company_id=$1 AND id=$2",[fixture.companyA,debit]);
 const after=await get(),diff=compareSealedAuditSnapshots(fixture.companyA,{id:before.snapshotId,sealed},{id:after.snapshotId,sealed:sealAuditSnapshot(after)});
 expect(diff.records.changed.map(r=>r.source).sort()).toEqual(['customer_invoice_line','journal_line','supplier_invoice_line']);
 expect(after.records.find(r=>r.source==='customer_invoice_line')?.data).toMatchObject({gl_account_id:debit,gl_account_code:'CLASSIFIED-100',gl_account_type:'expense',gl_account_subtype:'operating',gl_account_default_vat_code:'STANDARD'});
 expect(sealAuditSnapshot(before)).toEqual(sealed);expect(JSON.stringify(after)).not.toMatch(/Private line|Private classification/);
});
for(const kind of ['customer','supplier'] as const)it(`retains ${kind} application and reversal accounting dates independently of actual event time`,async()=>{
 const party=randomUUID(),payment=randomUUID(),invoice=randomUUID(),application=randomUUID(),reversal=randomUUID(),allocation=randomUUID();
 if(kind==='customer'){
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic history')",[party,fixture.companyA]);
  await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,created_by) VALUES($1,$2,$3,'2026-08-31',20,$4)",[payment,fixture.companyA,party,fixture.u1.id]);
  await pool.query("INSERT INTO customer_invoices(id,company_id,customer_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-08-31',20,$4)",[invoice,fixture.companyA,party,fixture.u1.id]);
 }else{
  await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic history')",[party,fixture.companyA]);
  await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,created_by) VALUES($1,$2,$3,'2026-08-31',20,$4)",[payment,fixture.companyA,party,fixture.u1.id]);
  await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-08-31',20,$4)",[invoice,fixture.companyA,party,fixture.u1.id]);
 }
 const payload=JSON.stringify({version:1,kind,applications:[{invoiceId:invoice,amount:'20.00'}]});
 await pool.query("INSERT INTO control_cash_application_intents(company_id,id,requester_person_id,payment_id,kind,accounting_date,amount,currency,payload,source_fingerprint) VALUES($1,$2,$3,$4,$5,'2026-09-01',20,'ZAR',$6,repeat('a',64))",[fixture.companyA,application,fixture.u1.id,payment,kind,payload]);
 await pool.query("INSERT INTO control_cash_application_reversal_intents(company_id,id,requester_person_id,original_intent_id,reversal_date,reason) VALUES($1,$2,$3,$4,'2026-09-15','Synthetic reversal')",[fixture.companyA,reversal,fixture.u1.id,application]);
 if(kind==='customer'){
  await pool.query('INSERT INTO customer_payment_allocations(id,payment_id,invoice_id,amount_allocated,application_intent_id) VALUES($1,$2,$3,20,$4)',[allocation,payment,invoice,application]);
  await pool.query("UPDATE customer_payment_allocations SET reversed_at='2026-09-09T10:00:00Z',reversal_intent_id=$2 WHERE id=$1",[allocation,reversal]);
 }else{
  await pool.query('INSERT INTO payment_allocations(id,payment_id,invoice_id,amount_allocated,application_intent_id) VALUES($1,$2,$3,20,$4)',[allocation,payment,invoice,application]);
  await pool.query("UPDATE payment_allocations SET reversed_at='2026-09-09T10:00:00Z',reversal_intent_id=$2 WHERE id=$1",[allocation,reversal]);
 }
 const result=await actor(ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:[kind==='customer'?'ar':'ap']}}));
 const data=result.records.find(r=>r.id===allocation)!.data;
 expect(data).toMatchObject({application_intent_id:application,reversal_intent_id:reversal,application_accounting_date:'2026-09-01',reversal_accounting_date:'2026-09-15'});
 expect(String(data.application_accounting_date)<=result.cutoff&&String(data.reversal_accounting_date)>result.cutoff).toBe(true);
 expect(()=>sealAuditSnapshot(result)).not.toThrow();
});
