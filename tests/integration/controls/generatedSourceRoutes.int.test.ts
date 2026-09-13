import {afterAll,beforeAll,expect,it} from 'vitest';
import {generatedSourceRoutesFixture} from './generatedSourceRoutesFixture';
import {cancelReconciliation} from '@/modules/accounting/services/bank/bankReconciliationCancelService';
let f:Awaited<ReturnType<typeof generatedSourceRoutesFixture>>;
beforeAll(async()=>{f=await generatedSourceRoutesFixture();},60000);afterAll(async()=>{if(f)await f.close();});

/**
 * Each of these three routes posted a journal carrying a `source` the kernel treats as generated, with no parent
 * control — refused inside the poisoning branch of `runJournalControl`, so the route answered 500
 * CONTROL_INTEGRITY_FAILED and committed nothing, whatever the handler caught. Each is now a direct
 * manual-equivalent post: an own-domain `source` the kernel does not reserve for a generated family, executed as
 * `journal.post` under the company's own journal approval policy.
 */

it('a bank reconciliation adjustment posts as its own non-generated source, with the reconciliation still named',async()=>{
 const recon=await f.reconciliation('A');
 const {status,body}=await f.request('/api/accounting/bank-reconciliations-action','POST',
  {action:'adjustment',reconciliationId:recon,bankAccountId:f.gl.A['1110'],contraAccountId:f.gl.A['6900'],amount:-125.5,description:'Synthetic unpresented cheque'});
 expect(status).toBe(200);
 const journalEntryId=String(body.data!.journalEntryId);
 const rows=await f.journals('A',recon);
 expect(rows).toHaveLength(1);
 expect(rows[0]).toMatchObject({id:journalEntryId,status:'posted',source:'auto_adjustment',source_record_id:recon,entry_date:'2026-09-15'});
});

it('an adjustment journal blocks cancelling its reconciliation under the old and the new source spelling',async()=>{
 const recon=await f.reconciliation('A');
 const {status}=await f.request('/api/accounting/bank-reconciliations-action','POST',
  {action:'adjustment',reconciliationId:recon,bankAccountId:f.gl.A['1110'],contraAccountId:f.gl.A['6900'],amount:10,description:'Synthetic adjustment'});
 expect(status).toBe(200);
 await expect(cancelReconciliation(f.companies.A,recon,f.fixture.u1.id)).rejects.toThrow(/adjustment journal/);
 // Production holds adjustments written under the previous spelling; the guard must still see those.
 await f.pool.query("UPDATE gl_journal_entries SET source='auto_bank_recon' WHERE company_id=$1 AND source_record_id=$2",[f.companies.A,recon]);
 await expect(cancelReconciliation(f.companies.A,recon,f.fixture.u1.id)).rejects.toThrow(/adjustment journal/);
 expect((await f.pool.query('SELECT id FROM bank_reconciliations WHERE company_id=$1 AND id=$2',[f.companies.A,recon])).rows).toHaveLength(1);
});

it('a SARS tax directive application posts its journal and records the payment',async()=>{
 const directive=await f.approvedDirective('A');
 const {status,body}=await f.request(`/api/accounting/tax-directives/apply?id=${directive}`,'POST',{paymentDate:'2026-09-15'});
 expect(status).toBe(200);
 expect(body.data).toMatchObject({gross:1000,paye:180,net:820,status:'applied'});
 const rows=await f.journals('A',directive);
 expect(rows).toHaveLength(1);
 expect(rows[0]).toMatchObject({status:'posted',source:'manual',source_record_id:directive,entry_date:'2026-09-15'});
 const payments=await f.pool.query('SELECT journal_entry_id FROM tax_directive_payments WHERE company_id=$1 AND tax_directive_id=$2',[f.companies.A,directive]);
 expect(payments.rows).toHaveLength(1);
 expect(payments.rows[0].journal_entry_id).toBe(rows[0]!.id);
});

it('a UIF declaration payment posts its journal and marks the declaration paid',async()=>{
 const declaration=await f.submittedUifDeclaration('A');
 const {status,body}=await f.request(`/api/payroll/uif?id=${declaration}`,'PATCH',{markPaid:true,paymentDate:'2026-09-15'});
 expect(status).toBe(200);
 expect(body.data).toMatchObject({totalPaid:200,status:'paid'});
 const rows=await f.journals('A',declaration);
 expect(rows).toHaveLength(1);
 expect(rows[0]).toMatchObject({status:'posted',source:'manual',source_record_id:declaration,entry_date:'2026-09-15'});
 const decl=await f.pool.query('SELECT status,journal_entry_id,payment_date::text AS payment_date FROM uif_declarations WHERE company_id=$1 AND id=$2',[f.companies.A,declaration]);
 expect(decl.rows[0]).toMatchObject({status:'paid',journal_entry_id:rows[0]!.id,payment_date:'2026-09-15'});
});

/**
 * These three posts are now subject to the company's journal approval policy, which is the point of routing them
 * through the direct controlled path. None of the three routes can carry an approvalId, so under a policy the post
 * is refused and the request writes nothing — asserted by outcome, since the refusal still reaches the client as a
 * 500 (an approval-required refusal raised inside `executeControlledOperation` poisons the control transaction, a
 * pre-existing defect of every direct journal post on this branch, reported separately).
 */
it('a company whose journal policy requires approval gets nothing posted and nothing recorded',async()=>{
 const recon=await f.reconciliation('B'),directive=await f.approvedDirective('B'),declaration=await f.submittedUifDeclaration('B');
 const adjustment=await f.request('/api/accounting/bank-reconciliations-action','POST',
  {action:'adjustment',reconciliationId:recon,bankAccountId:f.gl.B['1110'],contraAccountId:f.gl.B['6900'],amount:10,description:'Synthetic adjustment'},'u3');
 expect(adjustment.status).toBeGreaterThanOrEqual(400);
 expect(await f.journals('B',recon)).toEqual([]);
 const applied=await f.request(`/api/accounting/tax-directives/apply?id=${directive}`,'POST',{paymentDate:'2026-09-15'},'u3');
 expect(applied.status).toBeGreaterThanOrEqual(400);
 expect(await f.journals('B',directive)).toEqual([]);
 expect((await f.pool.query('SELECT id FROM tax_directive_payments WHERE company_id=$1 AND tax_directive_id=$2',[f.companies.B,directive])).rows).toEqual([]);
 const paid=await f.request(`/api/payroll/uif?id=${declaration}`,'PATCH',{markPaid:true,paymentDate:'2026-09-15'},'u3');
 expect(paid.status).toBeGreaterThanOrEqual(400);
 expect(await f.journals('B',declaration)).toEqual([]);
 // The whole request rolled back: the declaration is not left marked paid without its journal.
 expect((await f.pool.query('SELECT status,journal_entry_id FROM uif_declarations WHERE company_id=$1 AND id=$2',[f.companies.B,declaration])).rows[0])
  .toMatchObject({status:'submitted',journal_entry_id:null});
});
