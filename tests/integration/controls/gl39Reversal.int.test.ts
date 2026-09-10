import {afterAll,beforeAll,expect,it} from 'vitest';
import {gl39Fixture} from './gl39Fixture';
import {reverseJournalEntry} from '@/modules/accounting/services/gl/journalEntryPostingService';
let f:Awaited<ReturnType<typeof gl39Fixture>>;
beforeAll(async()=>{f=await gl39Fixture();});afterAll(async()=>{if(f)await f.close();});
async function posted(){const j=await f.journal();await f.post(j.id);return j;}
it('default inverse preserves original open accounting date including PostgreSQL Date decoding',async()=>{
 const j=await posted(),inverse=await f.reverse(j.id);expect(inverse.entryDate).toBe('2026-03-15');expect((await f.state(inverse.id)).fiscal_period_id).toBe(f.periods.original);
});
it('closed original period defaults to today and derives its distinct target fiscal period',async()=>{
 const j=await posted();await f.period('closed');
 try{const inverse=await f.reverse(j.id);expect(inverse.entryDate).toBe(f.today);expect((await f.state(inverse.id)).fiscal_period_id).toBe(f.periods.today);}
 finally{await f.period('open');}
});
it('explicit inverse date derives target period despite closed original period and approved material stays exact',async()=>{
 const j=await posted();await f.period('closed');
 try{const inverse=await f.approvedReverse(j.id,'2026-04-10');expect(inverse.entryDate).toBe('2026-04-10');expect((await f.state(inverse.id)).fiscal_period_id).toBe(f.periods.target);}
 finally{await f.period('open');}
});
it.each(['2026-02-28','not-a-date','2026-05-01'])('invalid/uncovered target %s writes no contra or reversal metadata',async date=>{
 const j=await posted();await expect(f.reverse(j.id,date)).rejects.toThrow();
 expect((await f.state(j.id)).reversed_at).toBeNull();expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[f.f.companyA,j.id])).rows).toHaveLength(0);
});
it('closed explicit target refuses before any inverse state persists',async()=>{
 const j=await posted();await f.period('closed',f.periods.target);
 try{await expect(f.reverse(j.id,'2026-04-10')).rejects.toThrow(/closed|period/i);expect((await f.state(j.id)).reversed_at).toBeNull();}
 finally{await f.period('open',f.periods.target);}
});
it('equal original date is accepted and exact contra leaves original posted and pair net zero',async()=>{
 const j=await posted(),inverse=await f.reverse(j.id,'2026-03-15');expect(inverse.status).toBe('posted');
 const original=await f.state(j.id);expect(original.status).toBe('posted');expect(original.reversed_at).not.toBeNull();
 const rows=(await f.pool.query('SELECT gl_account_id,sum(debit-credit)::text AS net FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=ANY($2::uuid[]) GROUP BY gl_account_id',[f.f.companyA,[j.id,inverse.id]])).rows;
 expect(rows).toHaveLength(2);for(const row of rows)expect(Number(row.net)).toBe(0);
 const lines=(await f.pool.query('SELECT gl_account_id,debit::text,credit::text FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 ORDER BY gl_account_id',[f.f.companyA,inverse.id])).rows;
 expect(lines.find(row=>row.gl_account_id===j.accounts[0])).toMatchObject({debit:'0.00',credit:'1000.23'});expect(lines.find(row=>row.gl_account_id===j.accounts[1])).toMatchObject({debit:'1000.23',credit:'0.00'});
});
it('second reversal cannot create another contra and draft original is refused',async()=>{
 const j=await posted();await f.reverse(j.id);await expect(f.reverse(j.id,'2026-04-11')).rejects.toThrow(/already reversed|material/i);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[f.f.companyA,j.id])).rows).toHaveLength(1);
 const draft=await f.journal();await expect(f.reverse(draft.id)).rejects.toThrow('Can only reverse posted');
});
it('actual child posting failure rolls back draft contra, metadata and reversal effect',async()=>{
 const j=await posted();await expect(f.actor(()=>reverseJournalEntry(f.f.companyA,j.id,f.f.u1.id,{reversalDate:'2026-04-10'}),'u1',false,true)).rejects.toThrow('Synthetic child posting failure');
 expect((await f.state(j.id)).reversed_at).toBeNull();expect((await f.state(j.id)).status).toBe('posted');
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[f.f.companyA,j.id])).rows).toHaveLength(0);
 expect((await f.pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='journal.reverse'",[f.f.companyA,j.id])).rows).toHaveLength(0);
});
it.each([false,true])('approved inverse preserves actual %s PAT versus human posting attribution',async pat=>{
 const j=await posted(),inverse=await f.approvedReverse(j.id,'2026-04-10',pat),row=await f.state(inverse.id);
 expect(row.posting_agent).toBe(pat?'mcp:reverse_journal:v1':`human:${f.f.u1.id}`);
 if(pat){expect(row.actor_type).toBe('agent');expect(row.actor_token_jti).toBe(f.f.u1.tokens[0]!.id);}
 else expect(row.actor_token_jti).toBeNull();
});
