import {beforeAll,afterAll,it,expect} from 'vitest';
import {apCiWorkflowFixture} from './apCiWorkflowFixture';
import {postSupplierInvoiceToGL} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
let f:Awaited<ReturnType<typeof apCiWorkflowFixture>>;
beforeAll(async()=>{f=await apCiWorkflowFixture();},30000);afterAll(async()=>{if(f)await f.close();});
it('reverses the real approved invoice exactly once with immutable original and repeat receipt',async()=>{
 const id=await f.invoice(),posted=await f.post(id),approvalId=await f.approve(f.ref('supplier_invoice.cancel',id));
 const result=await f.cancel(id,approvalId);expect(result.status).toBe('cancelled');
 expect(await f.cancel(id,approvalId)).toEqual(result);
 const journals=(await f.pool.query('SELECT id,status,reversed_at,reversal_of_id,source_document_id FROM gl_journal_entries WHERE company_id=$1 AND (id=$2 OR reversal_of_id=$2)',[f.f.companyA,posted.glJournalEntryId])).rows;
 expect(journals).toHaveLength(2);expect(journals.find(r=>r.id===posted.glJournalEntryId)).toMatchObject({status:'posted',source_document_id:null});expect(journals.find(r=>r.id===posted.glJournalEntryId).reversed_at).not.toBeNull();
 const lines=(await f.pool.query('SELECT gl_account_id,sum(debit)::text AS debit,sum(credit)::text AS credit FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=ANY($2::uuid[]) GROUP BY gl_account_id',[f.f.companyA,journals.map(r=>r.id)])).rows;
 expect(lines).toHaveLength(3);for(const line of lines)expect(line.debit).toBe(line.credit);
});
it('cancels an unposted bill without creating any journal',async()=>{
 const id=await f.invoice(),before=(await f.state()).gl_journal_entries,approvalId=await f.approve(f.ref('supplier_invoice.cancel',id));
 expect((await f.cancel(id,approvalId)).status).toBe('cancelled');expect((await f.state()).gl_journal_entries).toEqual(before);
});
it.each(['paid','partially_paid'])('refuses cancelling a current %s bill without any effect',async status=>{
 const id=await f.invoice();await f.pool.query('UPDATE supplier_invoices SET status=$3,amount_paid=1 WHERE company_id=$1 AND id=$2',[f.f.companyA,id,status]);
 const approvalId=await f.approve(f.ref('supplier_invoice.cancel',id)),before=await f.state();await expect(f.cancel(id,approvalId)).rejects.toThrow('with payments');expect(await f.state()).toEqual(before);
});
it('refuses cancelled and foreign invoice posting before any journal',async()=>{
 const id=await f.invoice();await f.pool.query("UPDATE supplier_invoices SET status='cancelled' WHERE company_id=$1 AND id=$2",[f.f.companyA,id]);const before=await f.state();
 await expect(f.actor(()=>postSupplierInvoiceToGL(f.f.companyA,id,f.f.u1.id))).rejects.toThrow('cancelled');
 await expect(f.actor(()=>postSupplierInvoiceToGL(f.f.companyB,id,f.f.u3.id),'u3')).rejects.toThrow('not found');expect(await f.state()).toEqual(before);
});
it('serializes two independently requested cancellations to one economic inverse',async()=>{
 const id=await f.invoice(),posted=await f.post(id),approvalId=await f.approve(f.ref('supplier_invoice.cancel',id));
 const results=await Promise.allSettled([f.cancel(id,approvalId),f.cancel(id,approvalId)]);expect(results.filter(r=>r.status==='fulfilled').length).toBeGreaterThanOrEqual(1);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[f.f.companyA,posted.glJournalEntryId])).rows).toHaveLength(1);
});
it('rolls back an inverse prefix when the final bill status write fails, even when caught',async()=>{
 const id=await f.invoice();await f.post(id);const approvalId=await f.approve(f.ref('supplier_invoice.cancel',id)),before=await f.state();
 await f.pool.query(`CREATE FUNCTION public.synthetic_ap_ci_cancel_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.f.companyA}'::uuid AND NEW.id='${id}'::uuid AND NEW.status='cancelled' THEN RAISE EXCEPTION 'Synthetic AP cancel failure'; END IF; RETURN NEW; END $$`);
 try{await f.pool.query('CREATE TRIGGER synthetic_ap_ci_cancel_failure BEFORE UPDATE ON supplier_invoices FOR EACH ROW EXECUTE FUNCTION public.synthetic_ap_ci_cancel_failure()');
  const errors:string[]=[];await expect(f.actor(async()=>{try{const {cancelSupplierInvoice}=await import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService');await cancelSupplierInvoice(f.f.companyA,id,f.f.u1.id,{approvalId});}catch(error){errors.push(String(error));}})).rejects.toThrow();
  expect(errors.join()).toContain('Synthetic AP cancel failure');expect(await f.state()).toEqual(before);
 }finally{await f.pool.query('DROP TRIGGER IF EXISTS synthetic_ap_ci_cancel_failure ON supplier_invoices');await f.pool.query('DROP FUNCTION public.synthetic_ap_ci_cancel_failure()');}
 expect((await f.cancel(id,approvalId)).status).toBe('cancelled');
});
