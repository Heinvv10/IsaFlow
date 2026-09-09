import {afterEach,beforeEach,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {transferFixture} from './bankTransferSourcesFixture';
import {seedTransferReceipt} from './bankTransferReceiptFixture';
import {loadBankTransferState} from '@/modules/accounting/services/bank/bankAllocationTransferState';
import type {BankTransferPlan} from '@/modules/accounting/services/bank/bankAllocationTransferPlan';
let f:Awaited<ReturnType<typeof transferFixture>>;
beforeEach(async()=>{process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');f=await transferFixture();});afterEach(async()=>{if(f)await f.close();});
const post=(bankTransactionId:string,oppositeBankTransactionId:string|null=null):BankTransferPlan=>({version:1,kind:'transfer',bankTransactionId,counterpartyAccountId:f.to,transfer:{mode:'post',oppositeBankTransactionId}});
const read=(plan:BankTransferPlan,after=false)=>f.actor(ctx=>loadBankTransferState(ctx,plan,after));
it('binds initial discovery to exactly the saved first opposite selection',async()=>{
 const bank=await f.bank(),opposite=await f.bank(f.to,'115.23'),plan=post(bank,opposite);
 expect(await read(plan)).toMatchObject({oppositeBank:{id:opposite},discovery:{oppositeCandidates:[{id:opposite}]}});
 await expect(read(post(bank))).rejects.toThrow(/selection|changed/);
});
it('does not rediscover late arrivals in a completed original post state',async()=>{
 const bank=await f.bank(),plan=post(bank),before=await read(plan,true);await f.bank(f.to,'115.23');
 expect(await read(plan,true)).toEqual(before);expect(before.discovery).toBeNull();expect(before.oppositeBank).toBeNull();
});
it('retains only the saved opposite after execution and allows imported post-reversal state',async()=>{
 const bank=await f.bank(),opposite=await f.bank(f.to,'115.23'),plan=post(bank,opposite),before=await read(plan,true);await f.bank(f.to,'115.23');
 expect(await read(plan,true)).toEqual(before);expect(before.bank.status).toBe('imported');expect(before.oppositeBank?.id).toBe(opposite);
});
it('refuses foreign saved opposite or changed signed amount',async()=>{
 const bank=await f.bank(),other=await f.account(f.f.companyB),foreign=await f.bank(other,'115.23','2026-09-09',f.f.companyB);
 await expect(read(post(bank,foreign),true)).rejects.toThrow();
 const opposite=await f.bank(f.to,'120');await expect(read(post(bank,opposite),true)).rejects.toThrow();
});
it('proves saved link before and after its exact destination occupation without rediscovery',async()=>{
 const original=await f.bank(),receipt=await seedTransferReceipt(f,original),bank=await f.bank(f.to,'115.23');
 const plan:BankTransferPlan={version:1,kind:'transfer',bankTransactionId:bank,counterpartyAccountId:f.from,transfer:{mode:'link',originalIntentId:receipt.intentId!}};
 expect((await read(plan)).original?.originalIntentId).toBe(receipt.intentId);
 await f.pool.query("UPDATE bank_transactions SET status='allocated',allocation_type='transfer',matched_journal_line_id=$3,transfer_journal_entry_id=$4,counterparty_account_id=$5 WHERE company_id=$1 AND id=$2",[f.f.companyA,bank,receipt.toLine,receipt.journal,f.from]);
 expect(await read(plan,true)).toMatchObject({original:{originalIntentId:receipt.intentId},discovery:null});
 await f.bank(f.to,'115.23');expect((await read(plan,true)).original?.originalIntentId).toBe(receipt.intentId);
 await f.pool.query('UPDATE bank_transactions SET transfer_journal_entry_id=NULL WHERE company_id=$1 AND id=$2',[f.f.companyA,bank]);
 await expect(read(plan,true)).rejects.toThrow();
});
it('refuses another occupant and a changed original journal',async()=>{
 const original=await f.bank(),receipt=await seedTransferReceipt(f,original),bank=await f.bank(f.to,'115.23');
 const plan:BankTransferPlan={version:1,kind:'transfer',bankTransactionId:bank,counterpartyAccountId:f.from,transfer:{mode:'link',originalIntentId:receipt.intentId!}};
 const other=await f.bank(f.to,'115.23');await f.pool.query("UPDATE bank_transactions SET matched_journal_line_id=$3 WHERE company_id=$1 AND id=$2",[f.f.companyA,other,receipt.toLine]);
 await expect(read(plan,true)).rejects.toThrow();
 await f.pool.query('UPDATE bank_transactions SET matched_journal_line_id=NULL WHERE company_id=$1 AND id=$2',[f.f.companyA,other]);
 await f.pool.query("UPDATE bank_transactions SET status='allocated',allocation_type='transfer',matched_journal_line_id=$3,transfer_journal_entry_id=$4,counterparty_account_id=$5 WHERE company_id=$1 AND id=$2",[f.f.companyA,bank,receipt.toLine,receipt.journal,f.from]);
 expect((await read(plan,true)).original?.originalIntentId).toBe(receipt.intentId);
 await f.pool.query('UPDATE gl_journal_lines SET credit=100 WHERE company_id=$1 AND id=$2',[f.f.companyA,receipt.fromLine]);await expect(read(plan,true)).rejects.toThrow();
});

it('permits a read-only reviewer and refuses revoked current bank read',async()=>{
 const bank=await f.bank();
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'accounts',true,false),($1,$2,'banking',true,false)",[f.f.companyA,f.f.u1.id]);
 expect((await read(post(bank))).bank.id).toBe(bank);
 await f.pool.query("UPDATE company_user_permissions SET can_read=false WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[f.f.companyA,f.f.u1.id]);
 await expect(read(post(bank))).rejects.toThrow();
});
