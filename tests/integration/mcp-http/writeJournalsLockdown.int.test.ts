import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {writeJournalsLockdownFixture} from './writeJournalsLockdownFixture';

/**
 * MCP tools/call post_journal, refused by company lockdown, over real HTTP through bearerPipeline.ts. That
 * pipeline carries the SAME controlWriteFailed-then-500 CONTROL_INTEGRITY_FAILED override withAuth.ts uses for
 * REST routes (both call withControlRequest and both re-check the flag after the handler returns). Before the
 * kernel precheck (runJournalControl, journalControlService.ts), a lockdown refusal fired from inside
 * assertPostingGuards, poisoning the request even though the registry (registry.ts) had already turned the throw
 * into an ordinary MCP business refusal (a 200 with isError:true) — bearerPipeline.ts then overrode that whole
 * response to 500. The kernel now throws before the controlled write opens, so the registry's own answer survives.
 */
let h:Awaited<ReturnType<typeof writeJournalsLockdownFixture>>;
beforeAll(async()=>{h=await writeJournalsLockdownFixture();},60000);
afterAll(async()=>{await h?.close();});

describe('MCP post_journal lockdown refusal',()=>{
 it('the write tools are actually registered',()=>{
  expect(h.registeredTools).toContain('create_draft_journal');
  expect(h.registeredTools).toContain('post_journal');
 });

 it('answers the MCP business refusal (200, isError, naming the lockdown) rather than 500 CONTROL_INTEGRITY_FAILED',async()=>{
  const draft=await h.call('create_draft_journal',{
   date:'2026-09-09',memo:'Synthetic MCP lockdown journal',
   lines:[{account_id:h.accounts[0],debit:100},{account_id:h.accounts[1],credit:100}],
   idempotency_key:crypto.randomUUID(),
  });
  expect(draft.status,draft.text).toBe(200);
  expect(draft.isError,draft.text).toBe(false);
  const journalId=(JSON.parse(draft.text) as {id:string}).id;

  await h.lockdown(true,null);
  try{
   const post=await h.call('post_journal',{journal_id:journalId,idempotency_key:crypto.randomUUID()});
   expect(post.status,JSON.stringify(post)).toBe(200);
   expect(post.isError,post.text).toBe(true);
   expect(post.text).toContain('lockdown');
   expect(await h.status(journalId)).toBe('draft');
  }finally{await h.lockdown(false,null);}
 });
});
