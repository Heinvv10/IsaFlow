import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bank39Fixture} from './bank39Fixture';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
let b:Awaited<ReturnType<typeof bank39Fixture>>;
beforeAll(async()=>{b=await bank39Fixture();});afterAll(async()=>{await b?.close();});
it('missing input VAT configuration refuses with an explicit configuration error and no intent or journal',async()=>{
 const tx=await b.source();
 await expect(b.actor(ctx=>prepareBankAllocation(ctx,{version:1,kind:'account',bankTransactionId:tx,lines:[{accountId:b.expense,amount:'115',vatCode:'standard'}]}))).rejects.toThrow('VAT system account missing or ambiguous');
 expect((await b.pool.query('SELECT id FROM control_bank_allocation_intents WHERE company_id=$1 AND bank_transaction_id=$2',[b.f.companyA,tx])).rows).toEqual([]);
 expect((await b.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[b.f.companyA,tx])).rows).toEqual([]);
});
it('canonical input VAT and legacy1140 each retain exact chosen ID before approval and post100 plus15 from gross115',async()=>{
 const vat=randomUUID();
 await b.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,'1140','BANK39 VAT Input','asset','vat_input','debit',true,true,3)",[vat,b.f.companyA]);
 for(const mode of ['vat_input','other_current_asset']){
  await b.pool.query('UPDATE gl_accounts SET account_subtype=$1 WHERE company_id=$2 AND id=$3',[mode,b.f.companyA,vat]);
  const tx=await b.source(),p=await b.prepare({version:1,kind:'account',bankTransactionId:tx,lines:[{accountId:b.expense,amount:'115',vatCode:'standard'}]});
  const saved=(await b.pool.query('SELECT payload,source_fingerprint FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[b.f.companyA,p.intentId])).rows[0];
  expect(saved.payload.vatAccountId).toBe(vat);expect(saved.source_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const posted=await b.actor(ctx=>executeBankAllocation(ctx,p.intentId,{approvalId:p.approvalId})),lines=await b.lines(posted.journalEntryId);
  expect(lines).toHaveLength(3);
  expect(lines.find(l=>l.gl_account_id===vat)).toMatchObject({debit:'15.00',credit:'0.00'});
  expect(lines.find(l=>l.gl_account_id===b.expense)).toMatchObject({debit:'100.00',credit:'0.00'});
  expect(lines.find(l=>l.gl_account_id===b.bank)).toMatchObject({debit:'0.00',credit:'115.00'});
 }
});
