import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {gl39Fixture} from './gl39Fixture';
import {postJournalEntry,ClosedFiscalPeriodError,InactiveAccountError} from '@/modules/accounting/services/gl/journalEntryPostingService';
let f:Awaited<ReturnType<typeof gl39Fixture>>;
beforeAll(async()=>{f=await gl39Fixture();});afterAll(async()=>{if(f)await f.close();});
it.each(['closed','locked'])('actual %s period throws the exported typed status and writes nothing',async status=>{
 const j=await f.journal();await f.period(status);
 try{
  const error=await f.post(j.id).catch((error:unknown)=>error);
  expect(error).toBeInstanceOf(ClosedFiscalPeriodError);expect(error).toMatchObject({periodStatus:status});
  expect((await f.state(j.id)).status).toBe('draft');
  expect((await f.pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[f.f.companyA,j.id])).rows).toHaveLength(0);
 }finally{await f.period('open');}
});
it('actual open-period post returns updated owned entry and persists one effect',async()=>{
 const j=await f.journal(),posted=await f.post(j.id);expect(posted.status).toBe('posted');expect((await f.state(j.id)).status).toBe('posted');
 expect((await f.pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[f.f.companyA,j.id])).rows).toHaveLength(1);
});
it('missing and foreign entries fail under an issued context without posting',async()=>{
 await expect(f.post(randomUUID())).rejects.toThrow(/not found|unavailable/i);
 const j=await f.journal();await expect(f.actor(()=>postJournalEntry(f.f.companyB,j.id,f.f.u3.id),'u3')).rejects.toThrow(/not found|unavailable/i);expect((await f.state(j.id)).status).toBe('draft');
});
it.each(['posted','reversed'])('source status %s cannot be newly posted',async status=>{
 const j=await f.journal();await f.pool.query('UPDATE gl_journal_entries SET status=$1 WHERE company_id=$2 AND id=$3',[status,f.f.companyA,j.id]);
 await expect(f.post(j.id)).rejects.toThrow(`Cannot post entry with status: ${status}`);
 expect((await f.state(j.id)).status).toBe(status);
});
it('all inactive owned line accounts produce a typed actionable error listing every code',async()=>{
 const j=await f.journal();await f.pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=ANY($2::uuid[])',[f.f.companyA,j.accounts]);
 const error=await f.post(j.id).catch((error:unknown)=>error);expect(error).toBeInstanceOf(InactiveAccountError);expect(error).toBeInstanceOf(Error);
 expect(error).toMatchObject({accounts:expect.arrayContaining(j.accounts.map(id=>id.slice(0,12)))});
 expect((error as Error).message).toMatch(/reactivate.*recode/i);for(const id of j.accounts)expect((error as Error).message).toContain(id.slice(0,12));
 expect((await f.state(j.id)).status).toBe('draft');
});
it('inactive account check is scoped to this owned entry and active entries still post',async()=>{
 const bad=await f.journal(),good=await f.journal();await f.pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=ANY($2::uuid[])',[f.f.companyA,bad.accounts]);
 expect((await f.post(good.id)).status).toBe('posted');expect((await f.state(bad.id)).status).toBe('draft');
});
it('unissued and revoked current authority cannot post even valid source facts',async()=>{
 const j=await f.journal();await expect(postJournalEntry(f.f.companyA,j.id,f.f.u1.id)).rejects.toThrow('Authenticated');
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'accounts',false)",[f.f.companyA,f.f.u1.id]);
 try{await expect(f.post(j.id)).rejects.toThrow('Current permissions');expect((await f.state(j.id)).status).toBe('draft');}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='accounts'",[f.f.companyA,f.f.u1.id]);}
});
