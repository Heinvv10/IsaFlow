import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {bankPreparedFixture} from './bankPreparedFixture';
type Prepared={intentId:string;operation:OperationRef;bankTransactionId?:string};
type Effect={journalEntryId:string;bankTransactionId:string;paymentId:null;reversalJournalEntryId?:string};
let f:Awaited<ReturnType<typeof bankPreparedFixture>>;
beforeAll(async()=>{f=await bankPreparedFixture();},30000);afterAll(async()=>{if(f)await f.close();});
const args=(instruction:Record<string,unknown>)=>({instruction,idempotency_key:randomUUID()});
it('actual PAT preparation, independent cookie approval, posting replay and opposite-feed inverse preserve economics and provenance',async()=>{
 const bank=await f.bank(),opposite=await f.bank(f.to,'115.23');
 const prepare=args({action:'prepare_allocate',bankTransactionId:bank,allocationType:'transfer',contraAccountId:f.to});
 const prepared=await f.call<Prepared>('prepare_bank_operation',prepare);expect(await f.journals()).toHaveLength(0);
 expect((await f.call<Prepared>('prepare_bank_operation',prepare)).intentId).toBe(prepared.intentId);
 const pending=await f.request({action:'request',ref:prepared.operation},'u1',true);expect(pending.status).toBe(200);
 const execute=args({action:'allocate',bankTransactionId:bank,intent_id:prepared.intentId,approval_id:pending.body.data.id});
 expect((await f.rpc('execute_bank_operation',execute,'u1',true)).result?.isError).toBe(true);
 expect((await f.request({action:'decide',approvalId:pending.body.data.id,decision:'approved'},'u1',true)).status).toBeGreaterThanOrEqual(400);
 expect(await f.patDecision(pending.body.data.id)).toBeGreaterThanOrEqual(400);
 expect(await f.journals()).toHaveLength(0);
 expect((await f.request({action:'decide',approvalId:pending.body.data.id,decision:'approved'},'u2',true)).status).toBe(200);
 const [posted,retry]=await Promise.all([f.call<Effect>('execute_bank_operation',execute),f.call<Effect>('execute_bank_operation',execute)]);
 expect(retry.journalEntryId).toBe(posted.journalEntryId);expect(posted.paymentId).toBeNull();expect(await f.journals()).toHaveLength(1);
 const stamp=(await f.pool.query('SELECT actor_type,actor_token_jti,posting_agent FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.f.companyA,posted.journalEntryId])).rows[0];
 expect(stamp).toEqual({actor_type:'agent',actor_token_jti:f.f.u1.tokens[0]!.id,posting_agent:'mcp:execute_bank_operation:v1'});
 const totals=(await f.pool.query('SELECT SUM(debit)::text AS debit,SUM(credit)::text AS credit FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[f.f.companyA,posted.journalEntryId])).rows[0];
 expect(totals).toEqual({debit:'115.23',credit:'115.23'});
 for(const id of [bank,opposite]){const read=await f.read(id);expect(read.status).toBe(200);expect(read.body.data.currentOriginalIntentId).toBe(prepared.intentId);}
 const before=await f.snapshot();
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'accounts',false)",[f.f.companyA,f.f.u1.id]);
 try{expect((await f.rpc('execute_bank_operation',execute,'u1',true)).result?.isError).toBe(true);}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='accounts'",[f.f.companyA,f.f.u1.id]);}
 expect(await f.snapshot()).toEqual(before);
 const inverse=await f.call<Prepared>('prepare_bank_operation',args({action:'prepare_reverse',bankTransactionId:opposite,originalIntentId:prepared.intentId,reversalDate:'2026-09-10',reason:'Synthetic MCP opposite-feed inverse'}));
 expect(inverse.bankTransactionId).toBe(bank);const approvalId=await f.approved(inverse.operation);
 const reverse=args({action:'reverse',bankTransactionId:inverse.bankTransactionId,intent_id:inverse.intentId,approval_id:approvalId});
 const reversed=await f.call<Effect>('execute_bank_operation',reverse);expect(reversed.reversalJournalEntryId).toBeTruthy();
 expect((await f.call<Effect>('execute_bank_operation',reverse)).reversalJournalEntryId).toBe(reversed.reversalJournalEntryId);
 expect(await f.journals()).toHaveLength(2);for(const row of await f.banks())expect(row).toMatchObject({status:'imported',matched_journal_line_id:null,counterparty_account_id:null,transfer_journal_entry_id:null});
 const provenance=(await f.pool.query('SELECT actor_type,actor_token_jti,posting_agent FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.f.companyA,reversed.reversalJournalEntryId])).rows[0];expect(provenance).toEqual(stamp);
 const receipts=(await f.pool.query("SELECT r.status FROM mcp_invocation_receipts r JOIN mcp_invocation_attempts a ON a.company_id=r.company_id AND a.id=r.attempt_id WHERE a.company_id=$1 AND a.tool='execute_bank_operation'",[f.f.companyA])).rows;
 expect(receipts.some(row=>row.status==='rejected')).toBe(true);expect(receipts.some(row=>row.status==='replay')).toBe(true);
},60000);
it('foreign identities, substituted execution fields and stale approvals refuse with no economic effect',async()=>{
 const bank=await f.bank(f.from,'-119.37'),foreign=await f.foreignBank();
 const before=await f.snapshot();
 expect((await f.rpc('prepare_bank_operation',args({action:'prepare_allocate',bankTransactionId:foreign,allocationType:'transfer',contraAccountId:f.to}))).result?.isError).toBe(true);
 const prepared=await f.call<Prepared>('prepare_bank_operation',args({action:'prepare_allocate',bankTransactionId:bank,allocationType:'transfer',contraAccountId:f.to}));
 expect((await f.rpc('prepare_bank_operation',args({action:'prepare_allocate',bankTransactionId:bank,allocationType:'transfer',contraAccountId:f.to}),'u3')).result?.isError).toBe(true);
 const approvalId=await f.approved(prepared.operation),execute=args({action:'allocate',bankTransactionId:bank,intent_id:prepared.intentId,approval_id:approvalId});
 expect((await f.rpc('execute_bank_operation',{...execute,instruction:{...execute.instruction,amount:'1.00'}})).result?.isError).toBe(true);
 expect((await f.rpc('execute_bank_operation',execute,'u3')).result?.isError).toBe(true);
 await f.pool.query('UPDATE bank_transactions SET amount=-120.37 WHERE company_id=$1 AND id=$2',[f.f.companyA,bank]);
 const changed=await f.snapshot();expect((await f.rpc('execute_bank_operation',execute)).result?.isError).toBe(true);
 expect(await f.snapshot()).toEqual(changed);expect(await f.journals()).toEqual(before.journals);expect(await f.effects()).toEqual(before.effects);
},45000);
