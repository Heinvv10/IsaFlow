import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {apCiWorkflowFixture} from './apCiWorkflowFixture';
let f:Awaited<ReturnType<typeof apCiWorkflowFixture>>;
beforeAll(async()=>{f=await apCiWorkflowFixture();},30000);afterAll(async()=>{if(f)await f.close();});
it('posts an owned bank credit and reverses exact invoice money without deleting application history',async()=>{
 const invoice=await f.invoice();await f.post(invoice);const payment=await f.payment(invoice),processed=await f.process(payment);
 expect(processed.status).toBe('processed');
 const line=(await f.pool.query('SELECT debit::text,credit::text FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 AND gl_account_id=$3',[f.f.companyA,processed.glJournalEntryId,f.accounts.bank])).rows;
 expect(line).toEqual([{debit:'0.00',credit:'115.00'}]);
 const approvalId=await f.approve(f.ref('supplier_payment.void',payment)),result=await f.voidPayment(payment,approvalId);expect(result.status).toBe('cancelled');
 expect(await f.voidPayment(payment,approvalId)).toEqual(result);
 expect((await f.pool.query('SELECT amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[f.f.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
 expect((await f.pool.query('SELECT a.amount_allocated::text FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND p.id=$2',[f.f.companyA,payment])).rows).toEqual([{amount_allocated:'115.00'}]);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[f.f.companyA,processed.glJournalEntryId])).rows).toHaveLength(1);
});
it('refuses a foreign bank at current material preparation before any GL effects',async()=>{
 const foreign=randomUUID();await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active) VALUES($1,$2,'FOREIGNBANK','Foreign bank','asset','bank','debit',true)",[foreign,f.f.companyB]);
 const invoice=await f.invoice();await f.post(invoice);const payment=await f.payment(invoice,foreign),before=await f.state();
 await expect(f.process(payment)).rejects.toThrow();expect(await f.state()).toEqual(before);
 expect((await f.pool.query('SELECT id FROM gl_journal_lines WHERE company_id=$1 AND gl_account_id=$2',[f.f.companyA,foreign])).rows).toEqual([]);
});
it('refuses voiding unprocessed and reconciled payments without financial changes',async()=>{
 const invoice=await f.invoice();await f.post(invoice);const payment=await f.payment(invoice);let approvalId=await f.approve(f.ref('supplier_payment.void',payment)),before=await f.state();
 await expect(f.voidPayment(payment,approvalId)).rejects.toThrow('Only processed');expect(await f.state()).toEqual(before);
 await f.process(payment);await f.pool.query("UPDATE supplier_payments SET status='reconciled' WHERE company_id=$1 AND id=$2",[f.f.companyA,payment]);approvalId=await f.approve(f.ref('supplier_payment.void',payment));before=await f.state();
 await expect(f.voidPayment(payment,approvalId)).rejects.toThrow('reconciled');expect(await f.state()).toEqual(before);
});
it('rolls back journal and invoice changes when final payment cancellation fails',async()=>{
 const invoice=await f.invoice();await f.post(invoice);const payment=await f.payment(invoice);await f.process(payment);
 const approvalId=await f.approve(f.ref('supplier_payment.void',payment)),before=await f.state();
 await f.pool.query(`CREATE FUNCTION public.synthetic_ap_ci_void_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.f.companyA}'::uuid AND NEW.id='${payment}'::uuid AND NEW.status='cancelled' THEN RAISE EXCEPTION 'Synthetic AP void failure'; END IF; RETURN NEW; END $$`);
 try{await f.pool.query('CREATE TRIGGER synthetic_ap_ci_void_failure BEFORE UPDATE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION public.synthetic_ap_ci_void_failure()');
  await expect(f.voidPayment(payment,approvalId)).rejects.toThrow('Synthetic AP void failure');expect(await f.state()).toEqual(before);
 }finally{await f.pool.query('DROP TRIGGER IF EXISTS synthetic_ap_ci_void_failure ON supplier_payments');await f.pool.query('DROP FUNCTION public.synthetic_ap_ci_void_failure()');}
 expect((await f.voidPayment(payment,approvalId)).status).toBe('cancelled');
});
/**
 * paymentInvoiceSource reads the settlement receipt with an ambiguity refusal rather than picking
 * the one matching the current journal, which is only safe if a payment cannot hold two process
 * receipts. Processing requires status 'approved', voiding leaves 'cancelled', and nothing returns a
 * supplier payment to 'approved' — changeBatchStatus is the sole writer of it and demands 'draft'.
 */
it('cannot re-process a voided payment, so one payment never holds two process receipts',async()=>{
 const invoice=await f.invoice();await f.post(invoice);const payment=await f.payment(invoice);await f.process(payment);
 const approvalId=await f.approve(f.ref('supplier_payment.void',payment));
 expect((await f.voidPayment(payment,approvalId)).status).toBe('cancelled');
 await expect(f.process(payment)).rejects.toThrow('must be approved before processing');
 expect((await f.pool.query(`SELECT id FROM control_operation_effects WHERE company_id=$1
  AND entity_type='supplier_payment' AND operation='supplier_payment.process' AND lower(entity_id)=lower($2)`,[f.f.companyA,payment])).rows).toHaveLength(1);
});
