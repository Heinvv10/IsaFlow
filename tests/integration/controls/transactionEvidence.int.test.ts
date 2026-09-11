import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '../../../src/modules/accounting/services/controls/context';
import {inspectTransactionEvidence} from '../../../src/modules/accounting/services/controls/transactionEvidenceService';
import {rewriteApprovalUnguarded} from './approvalGuardBypass';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
process.env.ENCRYPTION_KEY='synthetic-evidence-encryption-key';process.env.CONTROL_FINGERPRINT_KEY='synthetic-evidence-fingerprint-key';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:10000});
let fixture:ForensicFixture;
const ids={supplier:randomUUID(),invoice:randomUUID(),payment:randomUUID(),bank:randomUUID(),account:randomUUID(),journal:randomUUID(),line:randomUUID(),
 captured:randomUUID(),procurement:randomUUID(),attachment:randomUUID(),approval:randomUUID()};
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);const c=fixture.companyA,u=fixture.u1.id;
 await pool.query("INSERT INTO suppliers(id,company_id,name,bank_account_number) VALUES($1,$2,'SECRET SUPPLIER','SECRET BANK')",[ids.supplier,c]);
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance) VALUES($1,$2,'TEST-EVIDENCE','Secret account','asset','debit')",[ids.account,c]);
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,status,created_by) VALUES($1,$2,CURRENT_DATE,'draft',$3)",[ids.journal,c,u]);
 await pool.query('INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$4,100,0)',[ids.line,c,ids.journal,ids.account]);
 await pool.query('INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,0,100)',[c,ids.journal,ids.account]);
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,matched_journal_line_id) VALUES($1,$2,$3,CURRENT_DATE,-100,$4)",[ids.bank,c,ids.account,ids.line]);
 await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,'SECRET INVOICE',CURRENT_DATE,100,$4)",[ids.invoice,c,ids.supplier,u]);
 await pool.query('INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,created_by,gl_journal_entry_id) VALUES($1,$2,$3,CURRENT_DATE,100,$4,$5)',[ids.payment,c,ids.supplier,u,ids.journal]);
 await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,100)',[ids.payment,ids.invoice]);
 await pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type,matched_invoice_id) VALUES($1,$2,'SECRET FILE','pdf',$3)",[ids.captured,c,ids.invoice]);
 await pool.query("INSERT INTO procurement_documents(id,entity_type,entity_id,file_url) VALUES($1,'supplier_payment',$2,'SECRET URL')",[ids.procurement,ids.payment]);
 await pool.query("INSERT INTO bank_transaction_attachments(id,bank_transaction_id,file_url) VALUES($1,$2,'SECRET URL')",[ids.attachment,ids.bank]);
 await pool.query(`INSERT INTO control_operation_approvals(id,company_id,operation_id,operation,entity_type,entity_id,requester_person_id,binding,binding_hash,status,expires_at)
  VALUES($1,$2,$3,'supplier_payment.process','supplier_payment',$4,$5,'{}','synthetic','pending',NOW()+interval '1 day')`,[ids.approval,c,randomUUID(),ids.payment,u]);
});
afterAll(async()=>{await pool.end();});
async function inspect(input:{entityType:string;entityId:string;limit?:number;cursor?:string},foreign=false,pat=false,prepare?:()=>Promise<void>){
 const client=await pool.connect(),companyId=foreign?fixture.companyB:fixture.companyA,personId=foreign?fixture.u3.id:fixture.u1.id;
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:personId,company_id:companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),companyId]);
  const token=pat?fixture.u1.tokens[0]:null;
  const result=await withControlRequest({client,userId:personId,companyId,claims},{personId,companyId,authMethod:token?'pat':'cookie',
   connectionId:token?.id,grantId:token?.id,grantedScopes:token?['read:bank-tx']:null},async()=>{await prepare?.();return inspectTransactionEvidence(requireControlTx(),input);});
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
const root={entityType:'bank_transaction',entityId:ids.bank};
it('walks real bank/journal/payment/invoice/approval links and all three document stores without sensitive payloads',async()=>{
 const result=await inspect(root);expect(result.nodes.map(n=>n.entityId)).toEqual(expect.arrayContaining(Object.entries(ids).filter(([k])=>!['account','line'].includes(k)).map(([,v])=>v)));
 expect(result.coverage.documentCounts).toEqual({captured:1,procurement:1,bank_attachment:1});
 expect(result.coverage.historicalCoverage).toBe('untracked');expect(JSON.stringify(result)).not.toContain('SECRET');
 expect(result.coverage.gaps.some(g=>g.reason==='NATIVE_PROCUREMENT_PARENT_UNSUPPORTED')).toBe(true);
});
it('refuses foreign and nonexistent roots identically',async()=>{
 await expect(inspect(root,true)).rejects.toThrow('Evidence unavailable');
 await expect(inspect({...root,entityId:randomUUID()})).rejects.toThrow('Evidence unavailable');
});
it('live reduced scopes cannot reveal invoice neighbors through a readable bank root',async()=>{
 await pool.query("UPDATE personal_access_tokens SET scopes=ARRAY['read:bank-tx'] WHERE company_id=$1 AND id=$2",[fixture.companyA,fixture.u1.tokens[0]!.id]);
 const result=await inspect(root,false,true);expect(JSON.stringify(result)).not.toContain(ids.journal);expect(JSON.stringify(result)).not.toContain(ids.invoice);
 expect(result.coverage.status).toBe('partial');expect(result.coverage.documentCounts.bank_attachment).toBe(1);
});
it('foreign procurement original parent cannot be authorized through an own-tenant cross-link or colliding native invoice UUID',async()=>{
 const collision=randomUUID(),foreignDoc=randomUUID();
 await pool.query('INSERT INTO sage_supplier_invoices(id,company_id) VALUES($1,$2)',[collision,fixture.companyB]);
 await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,created_by) VALUES($1,$2,$3,'collision',CURRENT_DATE,$4)",[collision,fixture.companyA,ids.supplier,fixture.u1.id]);
 await pool.query("INSERT INTO procurement_documents(id,entity_type,entity_id) VALUES($1,'supplier_invoice',$2)",[foreignDoc,collision]);
 await pool.query("INSERT INTO document_links(document_id,linked_entity_type,linked_entity_id) VALUES($1,'supplier_payment',$2)",[foreignDoc,ids.payment]);
 expect(JSON.stringify(await inspect(root))).not.toContain(foreignDoc);
 await expect(inspect({entityType:'procurement_document',entityId:foreignDoc})).rejects.toThrow('Evidence unavailable');
});
it('paginates more than 100 stored attachments with exact visited counts and rejects stale cursors',async()=>{
 const bank=randomUUID();await pool.query('INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount) VALUES($1,$2,$3,CURRENT_DATE,1)',[bank,fixture.companyA,ids.account]);
 await pool.query('INSERT INTO bank_transaction_attachments(bank_transaction_id) SELECT $1 FROM generate_series(1,120)',[bank]);
 const input={entityType:'bank_transaction',entityId:bank,limit:20};let page=await inspect(input);const first=page.nextCursor!;
 const seen=new Set(page.nodes.map(n=>n.entityId));expect(page.coverage.documentCounts.bank_attachment).toBe(120);expect(page.coverage.visitedNodes).toBe(121);
 while(page.nextCursor){page=await inspect({...input,cursor:page.nextCursor});expect(page.nodes.length).toBeLessThanOrEqual(20);page.nodes.forEach(n=>{expect(seen.has(n.entityId)).toBe(false);seen.add(n.entityId);});}
 expect(seen.size).toBe(121);await pool.query('INSERT INTO bank_transaction_attachments(bank_transaction_id) VALUES($1)',[bank]);
 await expect(inspect({...input,cursor:first})).rejects.toThrow('cursor');
},30000);
it('reports persisted reversal relationships without inventing historical versions',async()=>{
 const reversal=randomUUID();await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,status,created_by,reversal_of_id) VALUES($1,$2,CURRENT_DATE,'draft',$3,$4)",[reversal,fixture.companyA,fixture.u1.id,ids.journal]);
 await pool.query("UPDATE gl_journal_entries SET status='posted',reversed_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[fixture.companyA,ids.journal]);
 const result=await inspect({entityType:'journal_entry',entityId:ids.journal});
 expect(result.nodes.find(n=>n.entityId===ids.journal)?.status).toBe('posted');
 expect(result.nodes.find(n=>n.entityId===ids.journal)?.flags).toContain('reversed');
 expect(result.edges.some(e=>e.relation==='reversal'&&[e.from.entityId,e.to.entityId].includes(reversal))).toBe(true);
 expect(result.nodes.find(n=>n.entityId===ids.journal)?.version).toBeNull();
});
it('dangling captured parent is an explicit unknown gap and does not disclose its identifier',async()=>{
 const document=randomUUID(),missing=randomUUID();
 await pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type,matched_invoice_id) VALUES($1,$2,'synthetic','pdf',$3)",[document,fixture.companyA,missing]);
 const result=await inspect({entityType:'captured_document',entityId:document});
 expect(JSON.stringify(result)).not.toContain(missing);expect(result.coverage.status).toBe('partial');
 expect(result.coverage.gaps.some(g=>g.reason==='MISSING_OR_INACCESSIBLE_LINK')).toBe(true);
});
it('expands persisted approval source versions and exact-parent decision evidence, reporting invalid refs without exposure',async()=>{
 const invalid=randomUUID(),foreign=randomUUID();
 await pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type) VALUES($1,$2,'unrelated','pdf')",[invalid,fixture.companyA]);
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'foreign-source')",[foreign,fixture.companyB]);
 const refs=[{entityType:'supplier_payment',entityId:ids.payment,store:'captured',evidenceId:ids.captured,version:null,hash:null},
  {entityType:'supplier_payment',entityId:ids.payment,store:'procurement',evidenceId:ids.procurement,version:null,hash:null},
  {entityType:'supplier_payment',entityId:ids.payment,store:'captured',evidenceId:invalid,version:null,hash:null}];
 await rewriteApprovalUnguarded(pool,"UPDATE control_operation_approvals SET binding=$3::jsonb WHERE company_id=$1 AND id=$2",[fixture.companyA,ids.approval,JSON.stringify({sourceVersions:[
  {entityType:'supplier_invoice',entityId:ids.invoice,version:1,fingerprint:'not-disclosed'},
  {entityType:'gl_account',entityId:ids.account,version:1,fingerprint:'not-disclosed'},
  {entityType:'supplier',entityId:foreign,version:1,fingerprint:'not-disclosed'}]})]);
 await pool.query("INSERT INTO control_operation_decisions(company_id,approval_id,policy_id,person_id,decision,evidence_refs) VALUES($1,$2,'synthetic',$3,'approved',$4::jsonb)",[fixture.companyA,ids.approval,fixture.u2.id,JSON.stringify(refs)]);
 const result=await inspect({entityType:'operation_approval',entityId:ids.approval});
 expect(result.edges.filter(e=>e.relation==='approval_decision_evidence')).toHaveLength(2);
 expect(result.edges.filter(e=>e.relation==='approval_source_version')).toHaveLength(2);
 expect(result.nodes.some(n=>n.entityId===ids.account)).toBe(true);
 expect(JSON.stringify(result)).not.toContain(invalid);expect(JSON.stringify(result)).not.toContain(foreign);expect(JSON.stringify(result)).not.toContain('not-disclosed');
 expect(result.coverage.gaps.some(g=>g.reason==='APPROVAL_EVIDENCE_PARENT_UNVERIFIED')).toBe(true);
});
it.each([true,false])('native approval cannot validate colliding Sage procurement evidence (foreign=%s)',async foreign=>{
 const native=randomUUID(),document=randomUUID();
 await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,created_by) VALUES($1,$2,$3,'approval-collision',CURRENT_DATE,$4)",[native,fixture.companyA,ids.supplier,fixture.u1.id]);
 await pool.query('INSERT INTO sage_supplier_invoices(id,company_id) VALUES($1,$2)',[native,foreign?fixture.companyB:fixture.companyA]);
 await pool.query("INSERT INTO procurement_documents(id,entity_type,entity_id) VALUES($1,'supplier_invoice',$2)",[document,native]);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:fixture.u1.id,company_id:fixture.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  const {validateApprovalEvidence}=await import('../../../src/modules/accounting/services/controls/approvalQueries');
  await expect(withControlRequest({client,userId:fixture.u1.id,companyId:fixture.companyA,claims},
   {personId:fixture.u1.id,companyId:fixture.companyA,authMethod:'cookie'},()=>validateApprovalEvidence(requireControlTx(),{entityType:'supplier_invoice',entityId:native} as never,
    [{entityType:'supplier_invoice',entityId:native,store:'procurement',evidenceId:document,version:null,hash:null}]))).rejects.toThrow(foreign?undefined:'Unsupported');
 }finally{await client.query('ROLLBACK');client.release();}
});
it('actual shared posting and reversal produces the posted reversed flag and recorded history',async()=>{
 const journal=randomUUID(),period=randomUUID(),credit=randomUUID();
 await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic evidence',1,2026,'2026-09-01','2026-09-30','open')",[period,fixture.companyA]);
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level) VALUES($1,$2,'EVIDENCE-CREDIT','Synthetic credit','liability','credit',3)",[credit,fixture.companyA]);
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,status,source,created_by) VALUES($1,$2,'2026-09-09',$3,'draft','manual',$4)",[journal,fixture.companyA,period,fixture.u1.id]);
 await pool.query('INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,100,0),($1,$2,$4,0,100)',[fixture.companyA,journal,ids.account,credit]);
 const {postJournalEntry,reverseJournalEntry}=await import('../../../src/modules/accounting/services/gl/journalEntryPostingService');
 const result=await inspect({entityType:'journal_entry',entityId:journal},false,false,async()=>{
  await postJournalEntry(fixture.companyA,journal,fixture.u1.id);
  await reverseJournalEntry(fixture.companyA,journal,fixture.u1.id,{reversalDate:'2026-09-10'});
 });
 expect(result.nodes.find(n=>n.entityId===journal)?.status).toBe('posted');
 expect(result.nodes.find(n=>n.entityId===journal)?.flags).toContain('reversed');
 expect(result.coverage.historicalCoverage).toBe('recorded_since');expect(result.coverage.earliestRecordedEvent).toBeTruthy();
 expect(result.edges.some(e=>e.relation==='reversal')).toBe(true);
});
it.each(['customer_invoice','customer_payment'])('traverses actual %s allocations, posting journals, credit notes and owned documents',async entityType=>{
 const c=fixture.companyA,u=fixture.u1.id,customer=randomUUID(),invoice=randomUUID(),payment=randomUUID(),credit=randomUUID();
 const invoiceJournal=randomUUID(),paymentJournal=randomUUID(),creditJournal=randomUUID(),reversal=randomUUID(),bank=randomUUID(),line=randomUUID();
 const invoiceDoc=randomUUID(),paymentDoc=randomUUID(),creditDoc=randomUUID(),capture=randomUUID();
 await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'SECRET CUSTOMER')",[customer,c]);
 for(const journal of [invoiceJournal,paymentJournal,creditJournal,reversal]){
  await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,status,created_by) VALUES($1,$2,CURRENT_DATE,'draft',$3)",[journal,c,u]);
 }
 await pool.query('UPDATE gl_journal_entries SET reversal_of_id=$3 WHERE company_id=$1 AND id=$2',[c,reversal,creditJournal]);
 await pool.query('INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$4,100,0)',[line,c,invoiceJournal,ids.account]);
 await pool.query('INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,matched_journal_line_id) VALUES($1,$2,$3,CURRENT_DATE,100,$4)',[bank,c,ids.account,line]);
 await pool.query('INSERT INTO customer_invoices(id,company_id,client_id,customer_id,invoice_number,invoice_date,total_amount,created_by,gl_journal_entry_id) VALUES($1,$2,$3,$3,$4,CURRENT_DATE,100,$5,$6)',[invoice,c,customer,invoice,u,invoiceJournal]);
 await pool.query('INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,created_by,gl_journal_entry_id) VALUES($1,$2,$3,CURRENT_DATE,100,$4,$5)',[payment,c,customer,u,paymentJournal]);
 await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,100)',[payment,invoice]);
 await pool.query("INSERT INTO credit_notes(id,company_id,type,client_id,customer_invoice_id,credit_date,created_by,gl_journal_entry_id) VALUES($1,$2,'customer',$3,$4,CURRENT_DATE,$5,$6)",[credit,c,customer,invoice,u,creditJournal]);
 await pool.query("INSERT INTO procurement_documents(id,entity_type,entity_id,file_url) VALUES($1,'customer_invoice',$2,'SECRET URL'),($3,'customer_payment',$4,'SECRET URL'),($5,'credit_note',$6,'SECRET URL')",[invoiceDoc,invoice,paymentDoc,payment,creditDoc,credit]);
 await pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type) VALUES($1,$2,'SECRET CAPTURE','pdf')",[capture,c]);
 await pool.query('UPDATE gl_journal_entries SET source_document_id=$3 WHERE company_id=$1 AND id=$2',[c,invoiceJournal,capture]);
 const result=await inspect({entityType,entityId:entityType==='customer_invoice'?invoice:payment});
 expect(result.nodes.map(n=>n.entityId)).toEqual(expect.arrayContaining([invoice,payment,credit,invoiceJournal,paymentJournal,creditJournal,reversal,bank,invoiceDoc,paymentDoc,creditDoc,capture]));
 expect(result.edges.some(e=>e.relation==='customer_payment_allocation')).toBe(true);
 expect(result.edges.filter(e=>e.relation==='posted_journal')).toHaveLength(3);
 expect(result.edges.some(e=>e.relation==='customer_invoice_credit')).toBe(true);expect(result.edges.some(e=>e.relation==='reversal')).toBe(true);
 expect(result.coverage.documentCounts).toEqual({captured:1,procurement:3,bank_attachment:0});
 expect(result.coverage.status).toBe('complete');expect(JSON.stringify(result)).not.toContain('SECRET');
 await expect(inspect({entityType,entityId:entityType==='customer_invoice'?invoice:payment},true)).rejects.toThrow('Evidence unavailable');
});
