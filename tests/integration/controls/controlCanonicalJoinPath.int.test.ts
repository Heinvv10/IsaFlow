import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transferControlFixture} from './bankTransferControlFixture';
import {fixture as cashFixture,pool as cashPool,postedCash} from './cashApplicationFixture';
import {captureStatements,expectCanonicalIndexCond,explainAsAppUser,expectIndexableCanonicalLookups,expectIntentProbe,expectIntentsByPrimaryKey,type Who} from './canonicalPlanCapture';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {readBankCurrentOriginal,type BankControlRow} from '@/modules/accounting/services/bank/bankControlReadProvenance';
import {readBankPreparedRows,resolveBankApprovalTarget} from '@/modules/accounting/services/bank/bankControlReadQueries';
import {readExistingTransferFacts} from '@/modules/accounting/services/bank/bankTransferCandidateQueries';
import {runControlledTransferLinks} from '@/modules/accounting/services/bank/bankTransferLinkService';
import {loadBankTransferState} from '@/modules/accounting/services/bank/bankAllocationTransferState';
import {loadBankTransferOriginalBanks} from '@/modules/accounting/services/bank/bankAllocationTransferOriginal';
import {reverseReconciledTransaction} from '@/modules/accounting/services/bank/bankAllocationService';
import {assertBankPaymentInverseIdentity} from '@/modules/accounting/services/controls/bankChildReversalGuard';
import {loadCashApplicationSources} from '@/modules/accounting/services/shared/cashApplicationSources';
import {queryInvoiceMatchOverrides} from '@/modules/accounting/services/ap/invoiceMatchOverrideQuery';
import type {BankTransferPlan} from '@/modules/accounting/services/bank/bankAllocationTransferPlan';
/**
 * Joins between a canonical control table and another relation's uuid column: `entity_id_canonical = i.id::text` is
 * not leakproof (uuid_out), so as app_user it is only an index condition where `i.id` reaches the canonical table as
 * a Param. Every bank-allocation, transfer, cash-application and override site is captured from the real service,
 * on a real posted transfer and a real posted receipt, and explained under RLS.
 */
let t:Awaited<ReturnType<typeof transferControlFixture>>,who:Who,posted:{intentId:string;approvalId:string;original:string;opposite:string;journalId:string};
const bankRow=async(id:string)=>(await t.pool.query('SELECT id,status,amount::text,transaction_date,bank_account_id,matched_journal_line_id,allocation_type,transfer_journal_entry_id,counterparty_account_id FROM bank_transactions WHERE company_id=$1 AND id=$2',[who.companyId,id])).rows[0] as BankControlRow&Record<string,unknown>;
beforeAll(async()=>{
 t=await transferControlFixture();who={companyId:t.f.companyA,personId:t.f.u1.id};
 const original=await t.bank(),prepared=await t.prepare(original) as {intentId:string;operation:OperationRef};
 const approvalId=await t.approve(prepared.operation);await t.execute(prepared.intentId,approvalId);
 const [effect]=(await t.pool.query("SELECT result->>'journalEntryId' AS journal FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2",[who.companyId,prepared.intentId])).rows;
 posted={intentId:prepared.intentId,approvalId,original,opposite:await t.bank(t.to,'115.23'),journalId:effect.journal};
},300000);
afterAll(async()=>{await t?.close();});
const explain=async(work:Parameters<typeof captureStatements>[2],as:Who=who,pool=t.pool)=>explainAsAppUser(pool,as,await captureStatements(pool,as,work));
it('bank provenance reads keep a canonical index path: legacy history, receipts and transfer originals',async()=>{
 const original=await bankRow(posted.original),stranger={...original,id:randomUUID(),matched_journal_line_id:randomUUID()};
 const explained=[...await explain(ctx=>readBankCurrentOriginal(ctx,original)),...await explain(ctx=>readBankCurrentOriginal(ctx,stranger))];
 expectIndexableCanonicalLookups(explained);
 expectCanonicalIndexCond(explained,"c.action='journal.post'",'control_change_events');
 expectIntentsByPrimaryKey(explained);
 for(const marker of ['e.binding_hash,e.operation_id,i.payload',"i.payload->'transfer'->>'oppositeBankTransactionId'=","AND e.result->>'journalEntryId'=$","OR lower(e.result->>'originalIntentId')="])
  expectIntentProbe(explained,marker);
},300000);
it('bank approval and prepared-row reads reach effects and approvals through the canonical index',async()=>{
 const explained=[...await explain(ctx=>resolveBankApprovalTarget(ctx,posted.approvalId)),
  ...await explain(ctx=>readBankPreparedRows(ctx,posted.original,true,null,posted.approvalId))];
 expectIndexableCanonicalLookups(explained);expectIntentsByPrimaryKey(explained);expectIntentProbe(explained,'FROM control_operation_approvals a JOIN LATERAL');
},300000);
it('transfer candidate facts, link discovery, link resume and saved link state use the canonical index',async()=>{
 const opposite=await bankRow(posted.opposite),plan={version:1,kind:'transfer',bankTransactionId:posted.opposite,counterpartyAccountId:t.from,
  transfer:{mode:'link',originalIntentId:posted.intentId}} as BankTransferPlan;
 const explained=[...await explain(ctx=>readExistingTransferFacts(ctx,opposite,t.from,{id:posted.journalId},[])),
  ...await explain(()=>runControlledTransferLinks(who.companyId,{bankAccountId:t.to})),
  ...await explain(ctx=>loadBankTransferState(ctx,plan,true)),
  ...await explain(ctx=>loadBankTransferOriginalBanks(ctx,{id:posted.intentId},{...plan,transfer:{mode:'post',oppositeBankTransactionId:null}} as BankTransferPlan,{id:posted.journalId},[]))];
 expectIndexableCanonicalLookups(explained);
 expectCanonicalIndexCond(explained,"i.payload->'transfer'->'oppositeBankTransactionId'='null'::jsonb",'control_operation_effects');
 expectCanonicalIndexCond(explained,'AND NOT EXISTS(SELECT 1 FROM control_operation_effects e','control_operation_approvals');
 expectCanonicalIndexCond(explained,'AND NOT EXISTS(SELECT 1 FROM control_operation_effects e','control_operation_effects');
 expectCanonicalIndexCond(explained,"AS journal_id FROM control_bank_allocation_intents i",'control_operation_effects');
 expectIntentsByPrimaryKey(explained);expectIntentProbe(explained,"OR lower(i.payload->'transfer'->>'originalIntentId')=");
 expectCanonicalIndexCond(explained,'e.binding_hash,e.result,i.id AS intent_id','control_operation_effects');
},300000);
it('bank reversal and payment inverse identity reach the original receipt through the canonical index',async()=>{
 const explained=[...await explain(()=>reverseReconciledTransaction(who.companyId,posted.original,who.personId)),
  ...await explain(ctx=>assertBankPaymentInverseIdentity(ctx,'customer',randomUUID(),posted.original,posted.journalId))];
 expectIndexableCanonicalLookups(explained);
 expectCanonicalIndexCond(explained,'ORDER BY e.committed_at DESC LIMIT 1','control_operation_effects');
 expectCanonicalIndexCond(explained,'LIMIT 2 FOR SHARE OF b,l,j','control_operation_effects');
},300000);
it('cash application sources and invoice override annotations keep an indexable canonical lookup',async()=>{
 const {invoice,posted:receipt}=await postedCash(),as={companyId:cashFixture.companyA,personId:cashFixture.u1.id};
 const explained=[...await explain(ctx=>loadCashApplicationSources(ctx,{version:1,kind:'customer',paymentId:receipt.paymentId!,accountingDate:'2026-09-10',
  applications:[{invoiceId:invoice,amount:'115.00'}]}),as,cashPool),
  ...await explain(ctx=>queryInvoiceMatchOverrides(ctx,randomUUID()),as,cashPool)];
 expectIndexableCanonicalLookups(explained);expectIntentProbe(explained,"AND i.currency='ZAR'");expectIntentsByPrimaryKey(explained);
 expectCanonicalIndexCond(explained,'AS approval_id,v.version','control_operation_approvals');
},300000);
