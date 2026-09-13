import {afterAll,beforeAll,expect,it} from 'vitest';
import {provisionalControlFixture} from './provisionalControlFixture';
import {reverseJournalEntry} from '@/modules/accounting/services/gl/journalEntryService';
import {als} from '@/lib/als';
let f:Awaited<ReturnType<typeof provisionalControlFixture>>;
beforeAll(async()=>{f=await provisionalControlFixture();},60000);afterAll(async()=>{if(f)await f.close();});

/**
 * The unattended provisional posting used to write an 'auto_bank_recon' journal and post it directly, which the
 * kernel refuses as a direct operation on a generated journal — and because that refusal poisons the request's
 * control transaction, it took the WHOLE statement import down with a 500, not just the predicted line. It now posts
 * through the controlled bank allocation, with an intent, a receipt and a parented journal.
 */

it('an imported line the predictor codes posts through the controlled allocation, as a provisional row needing evidence',async()=>{
 const supplier=`Synthetic Provisional Traders ${Date.now()}`;
 await f.predictableSupplier('A',supplier);
 const {response,tx}=await f.commit('A','u1',[{date:'2026-09-15',description:supplier,amount:'-115.00'}]);
 expect(response.status).toBe(200);
 const row=tx(supplier);
 expect(row.status).toBe('provisional');
 const {intents,effects}=await f.receipts('A',String(row.id));
 expect(intents).toHaveLength(1);
 expect(effects.filter(e=>e.operation==='bank_allocation.post')).toHaveLength(1);
 const journalEntryId=String(row.provisional_je_id);
 expect(journalEntryId).toBe(String((effects.find(e=>e.operation==='bank_allocation.post')!.result as {journalEntryId:string}).journalEntryId));
 // The journal is a generated one: posted, needing evidence, and attributed to the predictor rather than the importer.
 expect(await f.journal('A',journalEntryId)).toMatchObject({status:'posted',source:'auto_bank_recon',source_record_id:row.id,
  posting_agent:'ai-provisional:v1',needs_evidence:true,entry_date:'2026-09-15'});
 expect(Number(row.prediction_confidence)).toBeCloseTo(0.9,2);
 expect(row.matched_journal_line_id).not.toBeNull();
 // A DIRECT journal operation on it is still refused.
 await expect(f.actor(()=>reverseJournalEntry(f.companies.A,journalEntryId,f.fixture.u1.id,{reversalDate:'2026-09-16'})))
  .rejects.toThrow('Generated journal must be changed through its authorized domain operation');
});

it('the statement still imports when the predicted line cannot be posted, instead of failing the whole commit',async()=>{
 const supplier=`Synthetic Refused Traders ${Date.now()}`;
 await f.predictableSupplier('B',supplier);
 const {response,tx}=await f.commit('B','u3',[{date:'2026-09-15',description:supplier,amount:'-115.00'}]);
 expect(response.status).toBe(200);
 const row=tx(supplier);
 // Company B's approval policy refuses the allocation: the line is left exactly as imported, and the import stands.
 expect(row.status).toBe('imported');
 expect(row.provisional_je_id).toBeNull();
 expect(await f.journalsFor('B',String(row.id))).toEqual([]);
});

it('the outstanding route posts a provisional entry on demand and lists it',async()=>{
 const supplier=`Synthetic Outstanding Traders ${Date.now()}`;
 await f.predictableSupplier('A',supplier);
 const bankTxId=await f.imported('A',supplier,'-230.00');
 const posted=await f.request('/api/accounting/provisional/outstanding','POST',{bankTxIds:[bankTxId]});
 expect(posted.status).toBe(200);
 const results=posted.body.data!.results as {bankTxId:string;journalEntryId:string|null;error?:string}[];
 expect(results[0]!.error).toBeUndefined();
 expect(results[0]!.journalEntryId).toBeTruthy();
 const listed=await f.request('/api/accounting/provisional/outstanding','GET',null);
 expect((listed.body.data!.outstanding as {bankTxId:string}[]).map(r=>r.bankTxId)).toContain(bankTxId);
});

/**
 * Dismiss and undo reverse an EXISTING provisional journal. Both called reverseJournalEntry directly, which the
 * kernel refuses for the same reason — so every provisional entry was undismissable. They now go through the
 * controlled reversal of the owning allocation, honouring its approval policy.
 */

it('dismissing a provisional entry reverses it through the controlled reversal and returns the line to the queue',async()=>{
 const supplier=`Synthetic Dismiss Traders ${Date.now()}`;
 await f.predictableSupplier('A',supplier);
 const {tx}=await f.commit('A','u1',[{date:'2026-09-15',description:supplier,amount:'-345.00'}]);
 const row=tx(supplier),journalEntryId=String(row.provisional_je_id);
 const dismissed=await f.request(`/api/accounting/provisional/dismiss?jeId=${journalEntryId}`,'POST',{});
 expect(dismissed.status).toBe(200);
 const reversalId=String(dismissed.body.data!.reversalJournalEntryId);
 expect(await f.journal('A',reversalId)).toMatchObject({status:'posted',source:'auto_bank_recon'});
 expect(await f.journal('A',journalEntryId)).toMatchObject({reversed_at:expect.anything()});
 const after=await f.bankTx('A',String(row.id));
 expect(after).toMatchObject({status:'imported',provisional_je_id:null,matched_journal_line_id:null});
 // The reversal carries its own controlled receipt, not a bare journal.
 const {effects}=await f.receipts('A',String(row.id));
 expect(effects.filter(e=>e.operation==='bank_allocation.reverse')).toHaveLength(1);
});

it('undoing an auto-post run reverses the provisional entries it created',async()=>{
 const supplier=`Synthetic Undo Traders ${Date.now()}`;
 await f.predictableSupplier('A',supplier);
 const {tx}=await f.commit('A','u1',[{date:'2026-09-15',description:supplier,amount:'-460.00'}]);
 const row=tx(supplier),runId=String(row.auto_post_run_id);
 expect(runId).not.toBe('null');
 const undone=await f.request('/api/accounting/bank-auto-post','POST',{action:'undo',runId});
 expect(undone.status).toBe(200);
 expect(undone.body.data).toMatchObject({reversed:1,skipped:0});
 const after=await f.bankTx('A',String(row.id));
 expect(after).toMatchObject({status:'imported',provisional_je_id:null,auto_post_run_id:null});
 expect(await f.journal('A',String(row.provisional_je_id))).toMatchObject({reversed_at:expect.anything()});
});

/**
 * The population production already holds: provisional journals posted BEFORE the controls existed, with no intent
 * and no receipt to reverse against. The controlled reversal proves their provenance from the data instead — the
 * bank row still names the journal, and the journal still carries the one bank line for that amount.
 */
it('a provisional entry that predates the controls is dismissed on proven provenance, under the same controlled reversal',async()=>{
 const supplier=`Synthetic Legacy Traders ${Date.now()}`;
 await f.predictableSupplier('A',supplier);
 const {tx}=await f.commit('A','u1',[{date:'2026-09-15',description:supplier,amount:'-575.00'}]);
 const row=tx(supplier),journalEntryId=String(row.provisional_je_id);
 // Strip every trace of the controlled posting, leaving exactly what a pre-controls provisional entry looks like.
 const {intents}=await f.receipts('A',String(row.id));
 await f.pool.query("DELETE FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_allocation_intent' AND entity_id_canonical=$2",[f.companies.A,intents[0]!.id]);
 await f.pool.query('DELETE FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[f.companies.A,intents[0]!.id]);
 const dismissed=await f.request(`/api/accounting/provisional/dismiss?jeId=${journalEntryId}`,'POST',{});
 expect(dismissed.status).toBe(200);
 expect(await f.journal('A',journalEntryId)).toMatchObject({reversed_at:expect.anything()});
 expect(await f.bankTx('A',String(row.id))).toMatchObject({status:'imported',provisional_je_id:null});
 const {reversals,effects}=await f.receipts('A',String(row.id));
 // The reversal records WHICH journal it proved, since there is no original intent to point at.
 expect(reversals).toHaveLength(1);
 expect(reversals[0]).toMatchObject({original_intent_id:null,legacy_journal_entry_id:journalEntryId});
 expect(effects.filter(e=>e.operation==='bank_allocation.reverse')).toHaveLength(1);
});

it('a journal the bank row does not name as its provisional entry is refused, not reversed',async()=>{
 const supplier=`Synthetic Unproven Traders ${Date.now()}`;
 await f.predictableSupplier('A',supplier);
 const {tx}=await f.commit('A','u1',[{date:'2026-09-15',description:supplier,amount:'-690.00'}]);
 const row=tx(supplier),journalEntryId=String(row.provisional_je_id);
 const {intents}=await f.receipts('A',String(row.id));
 await f.pool.query("DELETE FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_allocation_intent' AND entity_id_canonical=$2",[f.companies.A,intents[0]!.id]);
 await f.pool.query('DELETE FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[f.companies.A,intents[0]!.id]);
 // The link the legacy proof depends on is gone: the journal is no longer reversible on provenance alone.
 await f.pool.query('UPDATE bank_transactions SET provisional_je_id=NULL WHERE company_id=$1 AND id=$2',[f.companies.A,row.id]);
 const dismissed=await f.request(`/api/accounting/provisional/dismiss?jeId=${journalEntryId}`,'POST',{});
 // The named refusal, not any 5xx: a proof that crashes instead of refusing would also fail the request, and that is
 // not the same thing.
 expect(dismissed.status).toBe(400);
 expect(String((dismissed.body as {error?:{message?:string}}).error?.message??dismissed.body.error)).toMatch(/provenance cannot be proven|names this provisional journal/);
 expect(await f.journal('A',journalEntryId)).toMatchObject({status:'posted',reversed_at:null});
 expect(await f.pool.query('SELECT id FROM control_bank_allocation_reversal_intents WHERE company_id=$1 AND legacy_journal_entry_id=$2',[f.companies.A,journalEntryId])).toMatchObject({rows:[]});
});

it('a journal whose bank line is no longer a provisional one is refused by the proof, not reversed',async()=>{
 const supplier=`Synthetic Moved Traders ${Date.now()}`;
 await f.predictableSupplier('A',supplier);
 const {tx}=await f.commit('A','u1',[{date:'2026-09-15',description:supplier,amount:'-805.00'}]);
 const row=tx(supplier),journalEntryId=String(row.provisional_je_id);
 const {intents}=await f.receipts('A',String(row.id));
 await f.pool.query("DELETE FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_allocation_intent' AND entity_id_canonical=$2",[f.companies.A,intents[0]!.id]);
 await f.pool.query('DELETE FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[f.companies.A,intents[0]!.id]);
 // The row still NAMES the journal — so the adapter finds it — but it is no longer a provisional line, which is the
 // state the proof rests on. Without that clause a journal belonging to some other lifecycle would be reversed here.
 await f.pool.query("UPDATE bank_transactions SET status='reconciled' WHERE company_id=$1 AND id=$2",[f.companies.A,row.id]);
 const dismissed=await f.request(`/api/accounting/provisional/dismiss?jeId=${journalEntryId}`,'POST',{});
 expect(dismissed.status).toBe(400);
 expect(String((dismissed.body as {error?:{message?:string}}).error?.message??dismissed.body.error)).toMatch(/provenance cannot be proven/);
 expect(await f.journal('A',journalEntryId)).toMatchObject({status:'posted',reversed_at:null});
 expect(await f.bankTx('A',String(row.id))).toMatchObject({status:'reconciled'});
});

/**
 * A DIRECT post or reverse of a journal a generated family owns is refused — and that refusal is a business answer the
 * caller can act on (use the owning operation), so it is raised before the controlled write rather than from inside it,
 * where it marked the whole request's control transaction failed and reached the caller as a 500.
 */
it('reversing a generated journal from the journal route is refused with the owning source named, not a 500',async()=>{
 const supplier=`Synthetic Direct Traders ${Date.now()}`;
 await f.predictableSupplier('A',supplier);
 const {tx}=await f.commit('A','u1',[{date:'2026-09-15',description:supplier,amount:'-920.00'}]);
 const row=tx(supplier),journalEntryId=String(row.provisional_je_id);
 const refused=await f.request('/api/accounting/journal-entries-action','POST',{id:journalEntryId,action:'reverse',reversal_date:'2026-09-16'});
 expect(refused.status).toBeGreaterThanOrEqual(400);
 expect(refused.status).toBeLessThan(500);
 expect(JSON.stringify(refused.body)).toMatch(/authorized domain operation \(source: auto_bank_recon\)/);
 // Nothing happened: the journal stands, and the bank line is untouched.
 expect(await f.journal('A',journalEntryId)).toMatchObject({status:'posted',reversed_at:null});
 expect(await f.bankTx('A',String(row.id))).toMatchObject({status:'provisional',provisional_je_id:journalEntryId});
});

it('a post whose actor is not the authenticated person poisons the request, so a handler that SWALLOWS it still cannot commit',async()=>{
 const supplier=`Synthetic Mismatch Traders ${Date.now()}`;
 await f.predictableSupplier('A',supplier);
 const bankTxId=await f.imported('A',`${supplier} unposted`,'-33.00');
 const {createJournalEntry}=await import('@/modules/accounting/services/gl/journalEntryService');
 const {postJournalEntry}=await import('@/modules/accounting/services/gl/journalEntryPostingService');
 const draft=await f.actor(()=>createJournalEntry(f.companies.A,{entryDate:'2026-09-15',description:'Synthetic mismatch draft',source:'manual',
  lines:[{glAccountId:f.expense.A,debit:33,credit:0,description:'Synthetic mismatch'},{glAccountId:f.bank.A,debit:0,credit:33,description:'Synthetic mismatch'}]},f.fixture.u1.id));
 /**
  * A posting actor who is not this request's principal is an INTEGRITY fault, not a business refusal, and the property
  * that matters is what happens when the CALLER SWALLOWS IT — a per-row driver catching and continuing, or a route
  * whose handler returns normally. The handler below does exactly that: it catches the error, records what it saw, and
  * returns a value. It must STILL be impossible to commit.
  *
  * Asserting only that the call rejects proves nothing here: the fixture's own actor() rolls back on any throw, so a
  * kernel that had stopped poisoning entirely would pass. What is asserted instead is the mechanism — the store's
  * `controlWriteFailed` flag, and `withControlRequest` refusing to let a normally-returning handler through with
  * ControlIntegrityError, which is the same refusal withAuth turns into a 500 in production.
  */
 let observed:{message:string;poisoned:boolean}|null=null;
 await expect(f.actor(async()=>{
  await f.requireControlTx().sql`UPDATE bank_transactions SET description='Synthetic mismatch touched' WHERE company_id=${f.companies.A}::uuid AND id=${bankTxId}::uuid`;
  let message='';
  try{await postJournalEntry(f.companies.A,draft.id,f.fixture.u2.id);}catch(error){message=error instanceof Error?error.message:String(error);}
  observed={message,poisoned:als.getStore()?.controlWriteFailed===true};
  return 'the handler returned normally';
 })).rejects.toThrow('Required control evidence could not be committed');
 expect(observed).toEqual({message:'Journal context does not match authenticated person and tenant',poisoned:true});
 expect(await f.journal('A',draft.id)).toMatchObject({status:'draft'});
 expect(String((await f.bankTx('A',bankTxId))!.description)).toBe(`${supplier} unposted`);
});
