import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,bank,customer,fixture,pool,postedCash} from './cashApplicationFixture';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {applyLegacyCashPlan} from '@/modules/accounting/services/shared/cashApplicationLegacyAdapter';
import {preparePayrollCompensation} from '@/modules/accounting/services/controls/payrollCompensationControl';
import {executeCompensationCaller} from '@/modules/accounting/services/controls/payrollCompensationLegacyAdapter';
import {recordBankRuleChange} from '@/modules/accounting/services/bank/bankRuleChangeControl';
import {readControlEntityHistory} from '@/modules/accounting/services/controls/controlChangeHistoryService';
import {openHistoryCursor,sealHistoryCursor} from '@/modules/accounting/services/controls/controlChangeHistoryCursor';
import {recordPaymentStatusApproval} from '@/modules/accounting/services/ap/supplierPaymentStatusControl';
import {invoiceSnapshotSources} from '@/modules/accounting/services/controls/auditSnapshotInvoiceQueries';
import {inspectTransactionEvidence} from '@/modules/accounting/services/controls/transactionEvidenceService';
import {runPayrollCalculation} from '@/modules/accounting/services/payroll/payrollCalculationBoundary';
import {loadJournalRiskPopulation} from '@/modules/accounting/services/controls/journalRiskQueries';
import {analyseJournalRisks} from '@/modules/accounting/services/controls/journalRiskAnalysis';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {appendEntityVersion,effectRows,entityVersions,eventSpellings,insertCaseVariantReceipt,ledgerRows,receiptsFor} from './intentReceiptRows';
async function approved(ref:OperationRef){const approval=await actor(()=>requestOperationApproval(requireControlTx(),ref));await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');return approval.id;}
async function oneCanonicalEffect(id:string,operation:string){
 const rows=await receiptsFor(pool,fixture.companyA,id,operation);
 expect(rows).toHaveLength(1);expect(rows[0]!.entity_id).toBe(id);expect(rows[0]!.result.intentId).toBe(id);
}
async function cashIntent(){
 const {posted,invoice}=await postedCash();
 const p=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115'}]}));
 return{posted,invoice,p,approvalId:await approved(p.operation)};
}
for(const uppercaseFirst of [true,false]){
 const spelling=(id:string)=>uppercaseFirst?id.toUpperCase():id,retry=(id:string)=>uppercaseFirst?id:id.toUpperCase();
 it(`legacy cash adapter first uppercase=${uppercaseFirst} applies once and replays the other spelling`,async()=>{
  const {posted,invoice,p,approvalId}=await cashIntent();
  const plan={paymentId:posted.paymentId!,lines:[{invoiceId:invoice,amount:115}]};
  const apply=(intentId:string,approval?:string)=>actor(()=>applyLegacyCashPlan(fixture.companyA,fixture.u1.id,'customer',plan,approval?{intentId,approvalId:approval}:{intentId}));
  const result=await apply(spelling(p.intentId),approvalId);
  expect(await apply(retry(p.intentId))).toEqual(result);
  expect(await apply(retry(p.intentId),approvalId)).toEqual(result);
  await oneCanonicalEffect(p.intentId,'cash_application.apply');
  expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows).toEqual([{amount_paid:'115.00'}]);
 });
 it(`legacy compensation caller first uppercase=${uppercaseFirst} assigns once and replays the other spelling`,async()=>{
  const employee=randomUUID(),component=randomUUID();
  await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,$3,'Synthetic','Caller','2020-01-01','active')",[employee,fixture.companyA,employee.slice(0,12)]);
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,'3601','earning')",[component,fixture.companyA,`Synthetic caller salary ${component}`]);
  const input={version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:employee,componentId:component,amount:'123.45',effectiveFrom:'2027-01-01'}]};
  const p=await actor(()=>preparePayrollCompensation(requireControlTx(),input)),approvalId=await approved(p.operation);
  const call=(intentId:string,approval?:string)=>actor(()=>executeCompensationCaller(fixture.companyA,input,approval?{intentId,approvalId:approval}:{intentId},fixture.u1.id));
  const result=await call(spelling(p.intentId),approvalId);
  expect(await call(retry(p.intentId))).toEqual(result);
  expect(await call(retry(p.intentId),approvalId)).toEqual(result);
  await oneCanonicalEffect(p.intentId,'payroll_compensation.change');
  expect((await pool.query('SELECT a.amount::text FROM payroll_employee_components a JOIN payroll_employees e ON e.id=a.employee_id WHERE e.company_id=$1 AND e.id=$2',[fixture.companyA,employee])).rows).toEqual([{amount:'123.45'}]);
 });
}
// bank_transaction ids always come from a pg uuid, so this spelling cannot arise for one in production. It stands
// in for the entity types whose first version row was written from an operation reference before canonicalization —
// the fixture database holds customer_invoice rows in exactly this state, with no lowercase twin.
it('an entity whose retained version is spelled in uppercase is extended, not forked, and keeps one event lineage',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',123.45,'Synthetic legacy version bank','imported')",[tx,fixture.companyA,bank]);
 await appendEntityVersion(pool,{id:fixture.u1.id,companyId:fixture.companyA},'bank_transaction',tx.toUpperCase());
 const p=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 const approvalId=await approved(p.operation);
 await actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId}));
 expect(await entityVersions(pool,fixture.companyA,'bank_transaction',tx)).toEqual([{entity_id:tx.toUpperCase(),version:2}]);
 // The event and its evidence belong to the same lineage as the version row they advance.
 expect(await eventSpellings(pool,fixture.companyA,'bank_transaction',tx)).toEqual({events:[tx.toUpperCase()],evidence:[tx.toUpperCase()]});
 // And a tenant asking for that entity's history is answered from the lineage, not refused.
 const history=await actor(()=>readControlEntityHistory(requireControlTx(),{entityType:'bank_transaction',entityId:tx}));
 expect(history.available).toBe(true);
 expect(history.available&&history.items.map(item=>item.newVersion)).toEqual([2]);
});
it('a rule change extends the lineage retained under a legacy spelling instead of being blocked by it',async()=>{
 const rule=randomUUID();
 await appendEntityVersion(pool,{id:fixture.u1.id,companyId:fixture.companyA},'bank_categorisation_rule',rule.toUpperCase());
 await actor(()=>recordBankRuleChange(requireControlTx(),rule,null,{id:rule,name:'Synthetic legacy rule'},'created'));
 expect(await entityVersions(pool,fixture.companyA,'bank_categorisation_rule',rule)).toEqual([{entity_id:rule.toUpperCase(),version:2}]);
 expect((await eventSpellings(pool,fixture.companyA,'bank_categorisation_rule',rule)).events).toEqual([rule.toUpperCase()]);
});
type Lineage={entityId:string;eventCount:number};
type HistoryPage={available:boolean;code?:string;lineages?:Lineage[];writerLineage?:string|null;lineageTieUnresolvable?:boolean;entity:{lineage?:string};items:{newVersion:number;eventId:string}[];nextCursor:string|null};
const history=(entityId:string,extra:Record<string,unknown>={})=>actor(()=>readControlEntityHistory(requireControlTx(),{entityType:'bank_transaction',entityId,...extra})) as Promise<unknown> as Promise<HistoryPage>;
it('a forked history is two named lineages, never a merge, and each pages without losing a sibling',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',123.45,'Synthetic forked history bank','imported')",[tx,fixture.companyA,bank]);
 await appendEntityVersion(pool,{id:fixture.u1.id,companyId:fixture.companyA},'bank_transaction',tx.toUpperCase());
 const p=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 const allocationApproval=await approved(p.operation);
 await actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId:allocationApproval}));
 // A more advanced canonical lineage appears beside the legacy one; writers now extend it.
 await appendEntityVersion(pool,{id:fixture.u1.id,companyId:fixture.companyA},'bank_transaction',tx,5);
 const r=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:p.intentId,reversalDate:'2026-09-11',reason:'Synthetic forked history inverse'}));
 const reversalApproval=await approved(r.operation);
 await actor(()=>executeBankAllocationReversal(requireControlTx(),r.intentId,{approvalId:reversalApproval}));
 const retained=async(lineage:string)=>(await pool.query('SELECT id FROM control_change_events WHERE company_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY new_version,id',
  [fixture.companyA,'bank_transaction',lineage])).rows.map((row:{id:string})=>row.id);
 expect((await retained(tx)).length).toBeGreaterThan(0);expect((await retained(tx.toUpperCase())).length).toBeGreaterThan(0);
 const fork=await history(tx);
 expect(fork).toMatchObject({available:false,code:'FORKED_LINEAGE',items:[],nextCursor:null});
 expect(fork.lineages!.map(row=>row.entityId).sort()).toEqual([tx,tx.toUpperCase()].sort());
 // Which lineage the next write extends, so an agent takes expected_version from the right one.
 expect(fork.writerLineage).toBe(tx);expect(fork.lineageTieUnresolvable).toBe(false);
 for(const lineage of [tx,tx.toUpperCase()]){
  const seen:string[]=[];let cursor:string|null=null;
  do{const page:HistoryPage=await history(tx,{lineage,limit:1,...(cursor?{cursor}:{})});
   expect(page.available).toBe(true);expect(page.entity.lineage).toBe(lineage);
   seen.push(...page.items.map(item=>item.eventId));cursor=page.nextCursor;}while(cursor);
  expect(seen).toEqual(await retained(lineage));
 }
 // A second canonical event gives that lineage a real cursor to misuse.
 const again=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 const againApproval=await approved(again.operation);
 await actor(()=>executeBankAllocation(requireControlTx(),again.intentId,{approvalId:againApproval}));
 const first=await history(tx,{lineage:tx,limit:1});
 expect(first.nextCursor).not.toBeNull();
 await expect(history(tx,{lineage:tx.toUpperCase(),limit:1,cursor:first.nextCursor})).rejects.toThrow('History cursor no longer matches authorized query');
 const {lineage:_bound,...unbound}=openHistoryCursor(first.nextCursor!);
 await expect(history(tx,{lineage:tx,limit:1,cursor:sealHistoryCursor(unbound)})).rejects.toThrow('History cursor predates lineage selection');
});
it('an explicit lineage on an entity with no retained history reads as untracked, not refused',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',1,'Synthetic untracked history bank','imported')",[tx,fixture.companyA,bank]);
 const page=await history(tx,{lineage:tx}) as HistoryPage&{coverage:{historical:string}};
 expect(page.available).toBe(true);expect(page.items).toEqual([]);expect(page.coverage.historical).toBe('untracked');
});
it('a raw id writer and the snapshot both follow the most advanced lineage of a fork',async()=>{
 const supplier=randomUUID(),payment=randomUUID(),ident={id:fixture.u1.id,companyId:fixture.companyA};
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic lineage supplier')",[supplier,fixture.companyA]);
 await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,created_by) VALUES($1,$2,$3,'2026-09-09',10,$4)",[payment,fixture.companyA,supplier,fixture.u1.id]);
 await appendEntityVersion(pool,ident,'supplier_payment',payment,1);
 await appendEntityVersion(pool,ident,'supplier_payment',payment.toUpperCase(),7);
 await actor(()=>recordPaymentStatusApproval(fixture.companyA,payment.toUpperCase(),fixture.u1.id,async()=>undefined));
 const versions=Object.fromEntries((await entityVersions(pool,fixture.companyA,'supplier_payment',payment)).map(row=>[row.entity_id,row.version]));
 expect(versions).toEqual({[payment]:1,[payment.toUpperCase()]:8});
 const source=invoiceSnapshotSources.find(row=>row.source==='supplier_payment')!;
 const rows=await actor(()=>source.page(requireControlTx(),'2026-12-31',null));
 expect(Number(rows.find(row=>row.id===payment)!.version)).toBe(8);
});
it('evidence records a lineage it cannot choose as a gap instead of failing the traversal',async()=>{
 const tx=randomUUID(),ident={id:fixture.u1.id,companyId:fixture.companyA};
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',1,'Synthetic ambiguous evidence bank','imported')",[tx,fixture.companyA,bank]);
 for(const spelling of [tx.toUpperCase(),`${tx.slice(0,8).toUpperCase()}${tx.slice(8)}`])await appendEntityVersion(pool,ident,'bank_transaction',spelling);
 const evidence=await actor(()=>inspectTransactionEvidence(requireControlTx(),{entityType:'bank_transaction',entityId:tx}));
 const root=evidence.nodes.find(node=>node.entityType==='bank_transaction'&&node.entityId===tx)!;
 expect(root.version).toBeNull();expect(root.flags).toContain('forked');expect(root.flags).not.toContain('ambiguous');
 expect(evidence.coverage.gaps).toContainEqual({source:{entityType:'bank_transaction',entityId:tx},reason:'CONTROL_LINEAGE_AMBIGUOUS'});
});
it('two retained spellings and no canonical lineage fail closed instead of forking a third',async()=>{
 const tx=randomUUID(),mixed=`${tx.slice(0,8).toUpperCase()}${tx.slice(8)}`;
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',123.45,'Synthetic ambiguous version bank','imported')",[tx,fixture.companyA,bank]);
 for(const spelling of [tx.toUpperCase(),mixed])await appendEntityVersion(pool,{id:fixture.u1.id,companyId:fixture.companyA},'bank_transaction',spelling);
 const p=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 const approvalId=await approved(p.operation);
 await expect(actor(()=>executeBankAllocation(requireControlTx(),p.intentId,{approvalId}))).rejects.toThrow('Ambiguous control entity version');
 expect(await entityVersions(pool,fixture.companyA,'bank_transaction',tx)).toHaveLength(2);
 expect(await receiptsFor(pool,fixture.companyA,p.intentId,'bank_allocation.post')).toHaveLength(0);
});
it('cash reversal refuses a case-variant twin receipt without another effect or ledger change',async()=>{
 const {p,approvalId}=await cashIntent();
 await actor(()=>executeCashApplication(requireControlTx(),p.intentId,{approvalId}));
 const r=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:p.intentId,reversalDate:'2026-09-11',reason:'Synthetic twin inverse'}));
 const inverseApproval=await approved(r.operation);
 await actor(()=>executeCashApplicationReversal(requireControlTx(),r.intentId,{approvalId:inverseApproval}));
 const [receipt]=await receiptsFor(pool,fixture.companyA,r.intentId,'cash_application.reverse');
 await insertCaseVariantReceipt(pool,{id:fixture.u1.id,companyId:fixture.companyA},receipt!.id);
 const before={effects:await effectRows(pool,fixture.companyA),ledger:await ledgerRows(pool,fixture.companyA)};
 for(const id of [r.intentId,r.intentId.toUpperCase()])await expect(actor(()=>executeCashApplicationReversal(requireControlTx(),id))).rejects.toThrow('Ambiguous operation receipt');
 expect({effects:await effectRows(pool,fixture.companyA),ledger:await ledgerRows(pool,fixture.companyA)}).toEqual(before);
});
type Ident={id:string;companyId:string};
const ident=():Ident=>({id:fixture.u1.id,companyId:fixture.companyA});
it('a forked payroll run recalculates on the lineage its calculation versions live in',async()=>{
 const run=randomUUID(),hash='b'.repeat(64);
 await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,9,2026,'draft')",[run,fixture.companyA]);
 // A DB-sourced writer baselined v1 under the canonical spelling; six real calculations ran through an uppercase route id.
 await appendEntityVersion(pool,ident(),'payroll_run',run,1);
 await appendEntityVersion(pool,ident(),'payroll_run',run.toUpperCase(),7);
 for(let v=2;v<=7;v++)await pool.query('INSERT INTO control_payroll_calculations(company_id,run_id,calculation_version,input_hash,output_hash,created_by) VALUES($1,$2,$3,$4,$4,$5)',[fixture.companyA,run,v,hash,fixture.u1.id]);
 await actor(()=>runPayrollCalculation(run,fixture.companyA,async()=>undefined));
 const versions=Object.fromEntries((await entityVersions(pool,fixture.companyA,'payroll_run',run)).map(row=>[row.entity_id,row.version]));
 expect(versions).toEqual({[run]:1,[run.toUpperCase()]:8});
 expect((await pool.query('SELECT max(calculation_version)::int AS v FROM control_payroll_calculations WHERE company_id=$1 AND run_id=$2',[fixture.companyA,run])).rows[0].v).toBe(8);
});
/** Appends a change event and its evidence as legacy source recorded them, copied from a real retained event. */
async function appendEvent(templateId:string,entityType:string,entityId:string,action:string,version:number|null=null){
 await pool.query(`WITH ev AS (INSERT INTO control_protected_evidence(company_id,id,entity_type,entity_id,key_id,envelope_version,ciphertext)
   SELECT p.company_id,gen_random_uuid(),$2,$3,p.key_id,p.envelope_version,p.ciphertext FROM control_change_events t
   JOIN control_protected_evidence p ON p.company_id=t.company_id AND p.id=t.protected_evidence_id WHERE t.company_id=$1 AND t.id=$5 RETURNING id)
  INSERT INTO control_change_events(company_id,id,person_id,connection_id,grant_id,acting_firm_id,request_id,operation_id,provenance,entity_type,entity_id,
   previous_version,new_version,action,accounting_date,before_values,after_values,binding_hash,protected_evidence_id)
  SELECT t.company_id,gen_random_uuid(),t.person_id,t.connection_id,t.grant_id,t.acting_firm_id,t.request_id,gen_random_uuid(),t.provenance,$2,$3,
   last.v,COALESCE($6::bigint,COALESCE(last.v,0)+1),$4,t.accounting_date,t.before_values,t.after_values,NULL,ev.id
  FROM control_change_events t,ev,(SELECT max(new_version) AS v FROM control_change_events WHERE company_id=$1 AND entity_type=$2 AND entity_id=$3) last
  WHERE t.company_id=$1 AND t.id=$5`,
  [fixture.companyA,entityType,entityId,action,templateId,version]);
}
it('a post-close edit retained under a non-canonical spelling still fires the journal signal, and the fork is flagged',async()=>{
 const {posted}=await postedCash(),journal=String(posted.journalEntryId);
 const [entry]=(await pool.query('SELECT fiscal_period_id FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,journal])).rows;
 const [template]=(await pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_type='journal_entry' AND entity_id=$2 ORDER BY new_version LIMIT 1",[fixture.companyA,journal])).rows;
 // The canonical lineage stays the one a lineage-picking reader would choose; the edit lives only in the other spelling.
 if(!(await entityVersions(pool,fixture.companyA,'journal_entry',journal)).some(row=>row.entity_id===journal))await appendEntityVersion(pool,ident(),'journal_entry',journal,1);
 await appendEntityVersion(pool,ident(),'journal_entry',journal.toUpperCase(),1);
 await appendEvent(template.id,'fiscal_period',String(entry.fiscal_period_id),'fiscal_period.close');
 await appendEvent(template.id,'journal_entry',journal.toUpperCase(),'journal.memo_changed');
 const population=await actor(()=>loadJournalRiskPopulation(requireControlTx(),null));
 const finding=analyseJournalRisks(population.rows,[]).find(row=>row.row.id===journal);
 expect(finding?.reasons).toContain('change_after_recorded_period_close');
 expect(finding?.reasons).toContain('change_history_lineage_forked');
 expect(finding?.reasons,'a fork with a canonical spelling at its top version is resolvable').not.toContain('change_history_lineage_tie_unresolvable');
});
/** Two retained spellings of one id, neither canonical. */
const nonCanonical=(id:string)=>{const upper=id.toUpperCase(),letter=upper.search(/[A-F]/);
 return[upper,`${upper.slice(0,letter)}${upper[letter]!.toLowerCase()}${upper.slice(letter+1)}`];};
async function journalTemplate(){
 const {posted}=await postedCash(),journal=String(posted.journalEntryId);
 const [template]=(await pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_type='journal_entry' AND entity_id=$2 ORDER BY new_version LIMIT 1",[fixture.companyA,journal])).rows;
 return{journal,template:template.id as string};
}
it('a journal whose top version ties across two non-canonical spellings is named as the tie writers refuse',async()=>{
 const {journal}=await journalTemplate();
 for(const spelling of nonCanonical(journal))await appendEntityVersion(pool,ident(),'journal_entry',spelling,99);
 const population=await actor(()=>loadJournalRiskPopulation(requireControlTx(),null));
 const finding=analyseJournalRisks(population.rows,[]).find(row=>row.row.id===journal);
 expect(finding?.reasons).toContain('change_history_lineage_forked');
 expect(finding?.reasons).toContain('change_history_lineage_tie_unresolvable');
});
it('a top-version tie with no canonical spelling is answered as the fork writers refuse',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',1,'Synthetic tied history bank','imported')",[tx,fixture.companyA,bank]);
 for(const spelling of nonCanonical(tx))await appendEntityVersion(pool,ident(),'bank_transaction',spelling,2);
 expect(await history(tx)).toMatchObject({available:false,code:'FORKED_LINEAGE',writerLineage:null,lineageTieUnresolvable:true});
});
it('history names the writer lineage from the version rows writers read, not from an event past its version row',async()=>{
 const {template}=await journalTemplate(),tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',1,'Synthetic writer lineage bank','imported')",[tx,fixture.companyA,bank]);
 await appendEntityVersion(pool,ident(),'bank_transaction',tx,5);
 await appendEntityVersion(pool,ident(),'bank_transaction',tx.toUpperCase(),3);
 // No current writer records an event past its lineage's version row; legacy rows may.
 await appendEvent(template,'bank_transaction',tx.toUpperCase(),'journal.memo_changed',9);
 const fork=await history(tx);
 expect(fork.code).toBe('FORKED_LINEAGE');
 expect(fork.writerLineage,'writers extend the canonical v5 version row').toBe(tx);
 expect(fork.lineageTieUnresolvable).toBe(false);
});
