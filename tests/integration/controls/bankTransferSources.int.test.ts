import {afterEach,beforeEach,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {transferFixture} from './bankTransferSourcesFixture';
import {seedTransferReceipt} from './bankTransferReceiptFixture';
import {readBankTransferCandidates} from '@/modules/accounting/services/bank/bankAllocationTransferSources';
let f:Awaited<ReturnType<typeof transferFixture>>;
beforeEach(async()=>{process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');f=await transferFixture();});afterEach(async()=>{if(f)await f.close();});
const read=(bankTransactionId:string,counterpartyAccountId=f.to)=>f.actor(ctx=>readBankTransferCandidates(ctx,{bankTransactionId,counterpartyAccountId}));
it.each(['-115.23','115.23'])('finds exact opposite signed cents for %s',async amount=>{
 const source=await f.bank(f.from,amount),opposite=await f.bank(f.to,amount.startsWith('-')?amount.slice(1):'-'+amount);
 const result=await read(source);expect(result.oppositeCandidates.map(r=>r.id)).toEqual([opposite]);expect(result.existingCandidates).toEqual([]);
 expect(result.bank.amount).toBe(amount);expect(result.sourceMetadata.currency).toBe('ZAR');expect(result.counterpartyMetadata).not.toHaveProperty('account_number');
});
it('orders inclusive two-day candidates by distance, newest creation and UUID',async()=>{
 const source=await f.bank(),near=await f.bank(f.to,'115.23','2026-09-09'),older=await f.bank(f.to,'115.23','2026-09-08'),newer=await f.bank(f.to,'115.23','2026-09-10');
 const lower=await f.bank(f.to,'115.23','2026-09-07'),upper=await f.bank(f.to,'115.23','2026-09-11');await f.bank(f.to,'115.23','2026-09-12');await f.bank(f.to,'115.24');
 await f.pool.query("UPDATE bank_transactions SET created_at='2026-09-01' WHERE company_id=$1 AND id=ANY($2::uuid[])",[f.f.companyA,[older,newer,lower,upper]]);
 const ids=(await read(source)).oppositeCandidates.map(r=>r.id);expect(ids).toEqual([near,...[older,newer].sort(),...[lower,upper].sort()]);
});
it('refuses foreign source/account and inactive or ambiguous metadata',async()=>{
 const source=await f.bank(),foreign=await f.account(f.f.companyB);
 await expect(read(source,foreign)).rejects.toThrow();await expect(f.actor(ctx=>readBankTransferCandidates(ctx,{bankTransactionId:source,counterpartyAccountId:f.to}),'u3')).rejects.toThrow();
 await f.pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[f.f.companyA,f.to]);await expect(read(source)).rejects.toThrow(/active/);
 await f.pool.query('UPDATE gl_accounts SET is_active=true WHERE company_id=$1 AND id=$2',[f.f.companyA,f.to]);
 await f.pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic duplicate metadata',$2,'ZAR')",[f.f.companyA,f.to]);await expect(read(source)).rejects.toThrow(/metadata/);
});
it('refuses zero and more than100 candidates',async()=>{
 const source=await f.bank(f.from,'0');await expect(read(source)).rejects.toThrow(/cents/);
 // Actual source column is numeric(15,2): sub-cent input rounds at storage; pure validation covers non-cent material.
 await f.pool.query('UPDATE bank_transactions SET amount=-115.23 WHERE company_id=$1 AND id=$2',[f.f.companyA,source]);
 await f.pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) SELECT gen_random_uuid(),$1,$2,'2026-09-09',115.23,'Synthetic bounded candidates','imported' FROM generate_series(1,101)",[f.f.companyA,f.to]);
 await expect(read(source)).rejects.toThrow(/bound/);
});
it('returns only a proven original receipt with an unused owned destination leg',async()=>{
 const original=await f.bank(),proof=await seedTransferReceipt(f,original),source=await f.bank(f.to,'115.23');
 const result=await read(source,f.from);expect(result.existingCandidates).toHaveLength(1);
 expect(result.existingCandidates[0]).toMatchObject({originalIntentId:proof.intentId,destinationLineId:proof.toLine});
});
it('refuses legacy economic duplicates and an occupied original destination',async()=>{
 const original=await f.bank(),proof=await seedTransferReceipt(f,original,false),source=await f.bank(f.to,'115.23');
 await expect(read(source,f.from)).rejects.toThrow(/receipt|provenance/);
 const second=await f.bank(f.from,'-90'),bound=await seedTransferReceipt(f,second),incoming=await f.bank(f.to,'90'),occupied=await f.bank(f.to,'90');
 await f.pool.query("UPDATE bank_transactions SET status='allocated',matched_journal_line_id=$3 WHERE company_id=$1 AND id=$2",[f.f.companyA,occupied,bound.toLine]);
 await expect(read(incoming,f.from)).rejects.toThrow(/occupied/);expect(proof.journal).toBeTruthy();
});
it('refuses extra foreign-account journal legs without dropping them from the proof population',async()=>{
 const original=await f.bank(),proof=await seedTransferReceipt(f,original),source=await f.bank(f.to,'115.23'),foreign=await f.account(f.f.companyB);
 await f.pool.query('INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$4,1,0)',[randomUUID(),f.f.companyA,proof.journal,foreign]);
 await expect(read(source,f.from)).rejects.toThrow(/provenance/);
});

it('refuses changed destination money even when its metadata still claims the original transfer',async()=>{
 const original=await f.bank(),proof=await seedTransferReceipt(f,original),source=await f.bank(f.to,'115.23');
 await f.pool.query('UPDATE gl_journal_lines SET debit=110 WHERE company_id=$1 AND id=$2',[f.f.companyA,proof.toLine]);
 await expect(read(source,f.from)).rejects.toThrow(/provenance/);
});
it('refuses current revoked posting permission and non-ZAR bank denomination',async()=>{
 const source=await f.bank();
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'accounts',false)",[f.f.companyA,f.f.u1.id]);
 await expect(read(source)).rejects.toThrow();
 await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='accounts'",[f.f.companyA,f.f.u1.id]);
 await f.pool.query("UPDATE bank_accounts SET currency='USD' WHERE company_id=$1 AND gl_account_id=$2",[f.f.companyA,f.to]);
 await expect(read(source)).rejects.toThrow(/ZAR/);
});
