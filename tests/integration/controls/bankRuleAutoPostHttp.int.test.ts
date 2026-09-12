import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bankRuleAutoPostHttpFixture} from './bankRuleAutoPostHttpFixture';
import {reverseJournalEntry} from '@/modules/accounting/services/gl/journalEntryService';
import {MAX_BANK_LINES_PER_REQUEST} from '@/lib/limits/authorityHoldLimits';
let f:Awaited<ReturnType<typeof bankRuleAutoPostHttpFixture>>;
beforeAll(async()=>{f=await bankRuleAutoPostHttpFixture();},60000);afterAll(async()=>{if(f)await f.close();});
const tag=()=>`SWEEP ${randomUUID()}`;
type Row=Record<string,unknown>;
async function receipt(company:string,tx:string){
 const intents=await f.pool.query('SELECT id FROM control_bank_allocation_intents WHERE company_id=$1 AND bank_transaction_id=$2',[company,tx]);
 const effects=intents.rows.length?await f.pool.query("SELECT result FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_allocation_intent' AND operation='bank_allocation.post' AND entity_id_canonical=$2",[company,intents.rows[0].id]):{rows:[]};
 return{intents:intents.rows,effects:effects.rows as {result:{journalEntryId:string;intentId:string;paymentId:string|null}}[]};
}
async function journals(company:string,tx:string){return (await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[company,tx])).rows;}
/** The line stayed exactly as imported: no intent, no effect, no journal, still open for a person. */
async function untouched(company:string,tx:Row){
 expect(tx.status).toBe('imported');expect(tx.matched_journal_line_id).toBeNull();
 const r=await receipt(company,String(tx.id));expect(r.intents).toEqual([]);expect(r.effects).toEqual([]);
 expect(await journals(company,String(tx.id))).toEqual([]);
}
/** The line posted through the controlled allocation: one intent, one receipt, a posted generated journal. */
async function posted(company:string,tx:Row,source:string){
 expect(tx.status).toBe('allocated');
 const {intents,effects}=await receipt(company,String(tx.id));expect(intents).toHaveLength(1);expect(effects).toHaveLength(1);
 const journal=await f.pool.query('SELECT status,source,source_record_id FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[company,effects[0]!.result.journalEntryId]);
 expect(journal.rows[0]).toMatchObject({status:'posted',source,source_record_id:tx.id});
 return effects[0]!.result;
}
/**
 * Every per-line refusal test commits the refused line WITH a sibling the same
 * import can post. A run that aborted at the refused line would leave the
 * sibling imported and report appliedRules 0 — indistinguishable from a skip
 * without it. The sibling is what proves the run continued.
 */
async function refusedWithSibling(key:'A'|'B',person:'u1'|'u3',line:{date:string;description:string;amount:string},counter:string){
 const sibling=tag();await f.rule(key,sibling);
 const {response,tx}=await f.commit(key,person,[line,{date:'2026-09-09',description:sibling,amount:'-20.00'}]);
 expect(response.status).toBe(200);
 expect(response.body.data).toMatchObject({appliedRules:1,[counter]:1});
 await untouched(f.companies[key],tx(line.description));
 await posted(f.companies[key],tx(sibling),'auto_bank_recon');
 return{response,tx};
}

it('an open-period account line posts through the controlled bank allocation with a receipt, and the journal is generated',async()=>{
 const description=tag();await f.rule('A',description,{vatCode:'standard'});
 const {response,tx}=await f.commit('A','u1',[{date:'2026-09-09',description,amount:'-115.00'}]);
 expect(response.status).toBe(200);expect(response.body.data.appliedRules).toBe(1);
 const row=tx(description),{journalEntryId}=await posted(f.companies.A,row,'auto_bank_recon');
 // The rule that posted it stays on the row, as the sweep has always recorded.
 expect(row.allocation_rule_name).toBe(`Synthetic sweep rule ${description}`);expect(row.allocation_type).toBe('account');
 // Net/VAT split is the controlled path's: R100 expense, R15 input VAT, R115 bank.
 const lines=await f.pool.query("SELECT a.account_subtype,jl.debit::text,jl.credit::text FROM gl_journal_lines jl JOIN gl_accounts a ON a.id=jl.gl_account_id WHERE jl.company_id=$1 AND jl.journal_entry_id=$2 ORDER BY a.account_subtype",[f.companies.A,journalEntryId]);
 expect(lines.rows).toEqual([{account_subtype:'bank',debit:'0.00',credit:'115.00'},{account_subtype:'default_expense',debit:'100.00',credit:'0.00'},{account_subtype:'vat_input',debit:'15.00',credit:'0.00'}]);
 const events=await f.pool.query("SELECT action FROM control_change_events WHERE company_id=$1 AND entity_type='bank_transaction' AND entity_id=$2",[f.companies.A,row.id]);
 expect(events.rows.map(r=>r.action)).toContain('bank_allocation.posted');
 // (d) A DIRECT journal operation on the generated journal is refused.
 await expect(f.actor(()=>reverseJournalEntry(f.companies.A,journalEntryId,f.fixture.u1.id,{reversalDate:'2026-09-10'}))).rejects.toThrow('Generated journal must be changed through its authorized domain operation');
 expect((await f.pool.query('SELECT reversed_at FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.companies.A,journalEntryId])).rows[0].reversed_at).toBeNull();
},60000);

it('a supplier rule with a verified beneficiary posts gross to payables and mints the supplier payment document',async()=>{
 const description=tag(),supplier=await f.verifiedSupplier();await f.rule('A',description,{supplierId:supplier,vatCode:'standard'});
 const {response,tx}=await f.commit('A','u1',[{date:'2026-09-09',description,amount:'-115.00'}]);
 expect(response.status).toBe(200);expect(response.body.data.appliedRules).toBe(1);
 const row=tx(description),result=await posted(f.companies.A,row,'auto_supplier_payment');
 expect(row.allocation_type).toBe('supplier');
 // K-017: the control account moves by the gross; the rule's VAT code claims nothing.
 const lines=await f.pool.query("SELECT a.account_subtype,jl.debit::text,jl.credit::text FROM gl_journal_lines jl JOIN gl_accounts a ON a.id=jl.gl_account_id WHERE jl.company_id=$1 AND jl.journal_entry_id=$2 ORDER BY a.account_subtype",[f.companies.A,result.journalEntryId]);
 expect(lines.rows).toEqual([{account_subtype:'bank',debit:'0.00',credit:'115.00'},{account_subtype:'payable',debit:'115.00',credit:'0.00'}]);
 const payment=await f.pool.query('SELECT supplier_id,total_amount::text,status,gl_journal_entry_id FROM supplier_payments WHERE company_id=$1 AND id=$2',[f.companies.A,result.paymentId]);
 expect(payment.rows[0]).toMatchObject({supplier_id:supplier,total_amount:'115.00',status:'processed',gl_journal_entry_id:result.journalEntryId});
},60000);

it('a customer rule on a receipt posts to receivables and mints the customer payment document',async()=>{
 const description=tag(),customer=await f.customer();await f.rule('A',description,{clientId:customer});
 const {response,tx}=await f.commit('A','u1',[{date:'2026-09-09',description,amount:'250.00'}]);
 expect(response.status).toBe(200);expect(response.body.data.appliedRules).toBe(1);
 const row=tx(description),result=await posted(f.companies.A,row,'auto_payment');
 expect(row.allocation_type).toBe('customer');
 const lines=await f.pool.query("SELECT a.account_subtype,jl.debit::text,jl.credit::text FROM gl_journal_lines jl JOIN gl_accounts a ON a.id=jl.gl_account_id WHERE jl.company_id=$1 AND jl.journal_entry_id=$2 ORDER BY a.account_subtype",[f.companies.A,result.journalEntryId]);
 expect(lines.rows).toEqual([{account_subtype:'bank',debit:'250.00',credit:'0.00'},{account_subtype:'receivable',debit:'0.00',credit:'250.00'}]);
 const payment=await f.pool.query('SELECT client_id,total_amount::text,status FROM customer_payments WHERE company_id=$1 AND id=$2',[f.companies.A,result.paymentId]);
 expect(payment.rows[0]).toMatchObject({client_id:customer,total_amount:'250.00',status:'confirmed'});
},60000);

it('a closed-period line is a per-line skip; the sibling line still posts',async()=>{
 const description=tag();await f.rule('A',description);
 await refusedWithSibling('A','u1',{date:'2026-08-15',description,amount:'-50.00'},'autoPostSkippedClosedPeriod');
},60000);

it('a line on or before the company lockdown date is a per-line skip; the sibling still posts',async()=>{
 const description=tag();await f.rule('A',description);
 await refusedWithSibling('A','u1',{date:'2026-07-15',description,amount:'-50.00'},'autoPostSkippedLockdown');
},60000);

it('a VAT-claiming line inside a filed VAT period is a per-line skip; a no-VAT line in the same period posts',async()=>{
 const claiming=tag(),plain=tag();await f.rule('A',claiming,{vatCode:'standard'});await f.rule('A',plain);
 const {response,tx}=await f.commit('A','u1',[{date:'2026-10-10',description:claiming,amount:'-115.00'},{date:'2026-10-10',description:plain,amount:'-30.00'}]);
 expect(response.status).toBe(200);
 expect(response.body.data).toMatchObject({appliedRules:1,autoPostSkippedVatPeriodFiled:1});
 await untouched(f.companies.A,tx(claiming));
 // Same filed period, no VAT line: outside the VAT201 population, so the lock does not apply.
 await posted(f.companies.A,tx(plain),'auto_bank_recon');
},60000);

it('a supplier rule whose supplier has no verified beneficiary is a per-line skip; the sibling still posts',async()=>{
 const description=tag(),supplier=await f.unverifiedSupplier();await f.rule('A',description,{supplierId:supplier});
 await refusedWithSibling('A','u1',{date:'2026-09-09',description,amount:'-75.00'},'autoPostSkippedBeneficiaryUnverified');
 expect((await f.pool.query('SELECT id FROM supplier_payments WHERE company_id=$1 AND supplier_id=$2',[f.companies.A,supplier])).rows).toEqual([]);
},60000);

it('a company whose policy binds the amount leaves the line unposted and reported, with no journal and no effect',async()=>{
 const description=tag();await f.rule('B',description);
 const {response,tx}=await f.commit('B','u3',[{date:'2026-09-09',description,amount:'-75.00'}]);
 expect(response.status).toBe(200);
 expect(response.body.data).toMatchObject({appliedRules:0,autoPostSkippedApprovalRequired:1});
 await untouched(f.companies.B,tx(description));
},60000);

it('a person without banking write permission gets every matched line refused per line, nothing posted, and a 200',async()=>{
 const description=tag();await f.rule('A',description);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'banking',false)",[f.companies.A,f.fixture.u1.id]);
 try{
  const {response,tx}=await f.commit('A','u1',[{date:'2026-09-09',description,amount:'-40.00'}]);
  expect(response.status).toBe(200);
  // Every still-imported line on the account re-matches its rule each run, so earlier refused lines count here too.
  expect(response.body.data.appliedRules).toBe(0);expect(response.body.data.autoPostSkippedPermissionDenied).toBeGreaterThanOrEqual(1);
  await untouched(f.companies.A,tx(description));
 }finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[f.companies.A,f.fixture.u1.id]);}
},60000);

it('posts at most the per-request bound, defers the rest, and the next run picks them up',async()=>{
 const prefix=tag();await f.rule('A',prefix);
 const lines=Array.from({length:MAX_BANK_LINES_PER_REQUEST+2},(_,i)=>({date:'2026-09-09',description:`${prefix} ${i}`,amount:'-10.00'}));
 const first=await f.commit('A','u1',lines);
 expect(first.response.status).toBe(200);
 // Exactly the bound posted; at least our two surplus lines deferred (lines earlier tests left imported may post too).
 expect(first.response.body.data.appliedRules).toBe(MAX_BANK_LINES_PER_REQUEST);
 expect(first.response.body.data.autoPostDeferred).toBeGreaterThanOrEqual(2);
 const deferred=lines.map(line=>first.tx(line.description)).filter(row=>row.status==='imported');
 expect(deferred.length).toBeGreaterThanOrEqual(2);
 // The next import of the account runs the sweep again: the deferred lines match again and post with the new line.
 const sibling=tag();await f.rule('A',sibling);
 const second=await f.commit('A','u1',[{date:'2026-09-09',description:sibling,amount:'-5.00'}]);
 expect(second.response.body.data.appliedRules).toBe(deferred.length+1);expect(second.response.body.data.autoPostDeferred).toBe(0);
 for(const row of deferred)expect((await f.pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[f.companies.A,row.id])).rows[0].status).toBe('allocated');
},60000);
