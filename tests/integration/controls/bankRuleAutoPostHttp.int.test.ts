import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bankRuleAutoPostHttpFixture} from './bankRuleAutoPostHttpFixture';
import {reverseJournalEntry} from '@/modules/accounting/services/gl/journalEntryService';
let f:Awaited<ReturnType<typeof bankRuleAutoPostHttpFixture>>;
beforeAll(async()=>{f=await bankRuleAutoPostHttpFixture();});afterAll(async()=>{if(f)await f.close();});
const tag=()=>`SWEEP ${randomUUID()}`;
async function receipt(company:string,tx:string){
 const intents=await f.pool.query('SELECT id FROM control_bank_allocation_intents WHERE company_id=$1 AND bank_transaction_id=$2',[company,tx]);
 const effects=intents.rows.length?await f.pool.query("SELECT result FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_allocation_intent' AND operation='bank_allocation.post' AND entity_id_canonical=$2",[company,intents.rows[0].id]):{rows:[]};
 return{intents:intents.rows,effects:effects.rows as {result:{journalEntryId:string;intentId:string}}[]};
}
it('an open-period line posts through the controlled bank allocation with a receipt, and the journal is generated',async()=>{
 const description=tag();await f.rule('A',description,{vatCode:'standard'});
 const {response,tx}=await f.commit('A','u1',{date:'2026-09-09',description,amount:'-115.00'});
 expect(response.status).toBe(200);expect(response.body.data.appliedRules).toBe(1);
 expect(tx).toBeDefined();expect(tx!.status).toBe('allocated');
 const {intents,effects}=await receipt(f.companies.A,String(tx!.id));
 expect(intents).toHaveLength(1);expect(effects).toHaveLength(1);
 const journalId=effects[0]!.result.journalEntryId;
 const journal=await f.pool.query('SELECT status,source,source_record_id FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.companies.A,journalId]);
 expect(journal.rows[0]).toMatchObject({status:'posted',source:'auto_bank_recon',source_record_id:tx!.id});
 // The rule that posted it stays on the row, as the sweep has always recorded.
 expect(tx!.allocation_rule_name).toBe(`Synthetic sweep rule ${description}`);expect(tx!.allocation_type).toBe('account');
 // Net/VAT split is the controlled path's: R100 expense, R15 input VAT, R115 bank.
 const lines=await f.pool.query("SELECT a.account_subtype,jl.debit::text,jl.credit::text FROM gl_journal_lines jl JOIN gl_accounts a ON a.id=jl.gl_account_id WHERE jl.company_id=$1 AND jl.journal_entry_id=$2 ORDER BY a.account_subtype",[f.companies.A,journalId]);
 expect(lines.rows).toEqual([{account_subtype:'bank',debit:'0.00',credit:'115.00'},{account_subtype:'default_expense',debit:'100.00',credit:'0.00'},{account_subtype:'vat_input',debit:'15.00',credit:'0.00'}]);
 // A change event under the allocation's operation id proves the same receipts the manual path writes.
 const events=await f.pool.query("SELECT action FROM control_change_events WHERE company_id=$1 AND entity_type='bank_transaction' AND entity_id=$2",[f.companies.A,tx!.id]);
 expect(events.rows.map(r=>r.action)).toContain('bank_allocation.posted');
 // (d) A DIRECT journal operation on the generated journal is refused.
 await expect(f.actor(()=>reverseJournalEntry(f.companies.A,journalId,f.fixture.u1.id,{reversalDate:'2026-09-10'}))).rejects.toThrow('Generated journal must be changed through its authorized domain operation');
 expect((await f.pool.query('SELECT reversed_at FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.companies.A,journalId])).rows[0].reversed_at).toBeNull();
},60000);
it('a closed-period line is reported per line with a 200, nothing written',async()=>{
 const description=tag();await f.rule('A',description);
 const {response,tx}=await f.commit('A','u1',{date:'2026-08-15',description,amount:'-50.00'});
 expect(response.status).toBe(200);expect(response.body.data.appliedRules).toBe(0);
 expect(tx!.status).toBe('imported');expect(tx!.matched_journal_line_id).toBeNull();
 expect((await receipt(f.companies.A,String(tx!.id))).intents).toEqual([]);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[f.companies.A,tx!.id])).rows).toEqual([]);
},60000);
it('a company whose policy binds the amount leaves the line unposted and reported, with no journal and no effect',async()=>{
 const description=tag();await f.rule('B',description);
 const {response,tx}=await f.commit('B','u3',{date:'2026-09-09',description,amount:'-75.00'});
 expect(response.status).toBe(200);expect(response.body.data.appliedRules).toBe(0);
 expect(response.body.data.autoPostSkippedApprovalRequired).toBe(1);
 expect(tx!.status).toBe('imported');expect(tx!.matched_journal_line_id).toBeNull();
 const {intents,effects}=await receipt(f.companies.B,String(tx!.id));
 expect(intents).toEqual([]);expect(effects).toEqual([]);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[f.companies.B,tx!.id])).rows).toEqual([]);
},60000);
