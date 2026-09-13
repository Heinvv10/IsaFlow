import {afterAll,beforeAll,expect,it} from 'vitest';
import {provisionalControlFixture} from './provisionalControlFixture';
import {reverseJournalEntry} from '@/modules/accounting/services/gl/journalEntryService';
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
