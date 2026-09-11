import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {journalEntryActionRouteFixture} from './journalEntryActionRouteFixture';

/**
 * POST /api/accounting/journal-entries-action { action: 'post' }, refused by company lockdown or a closed fiscal
 * period, over real HTTP. The guard that answers this lives inside postJournalEntry's controlled write
 * (assertPostingGuards), and firing it there marks the request's control transaction failed regardless of what the
 * route catches — withAuth then overrides the response to 500 CONTROL_INTEGRITY_FAILED. The kernel
 * (runJournalControl, journalControlService.ts) now runs the same postingPeriodBlock predicate BEFORE it opens the
 * controlled write for a direct (no-parentControl) post or reverse, and throws the same error classes
 * assertPostingGuards throws — ClosedFiscalPeriodError or the lockdown Error — which this route (and every other
 * direct caller of postJournalEntry/reverseJournalEntry) maps to 422 without ever touching the poisoning path. The
 * in-guard check inside assertPostingGuards stays as the backstop for the TOCTOU window between the two.
 */
let h:Awaited<ReturnType<typeof journalEntryActionRouteFixture>>;
beforeAll(async()=>{h=await journalEntryActionRouteFixture();},60000);
afterAll(async()=>{await h?.close();});

describe('POST /api/accounting/journal-entries-action lockdown and closed-period refusals',()=>{
 it('refuses a lockdown-enabled company with no lockdown_date as a 422 naming the lockdown, not a 500',async()=>{
  const id=await h.journal('2026-09-09');
  await h.lockdown(true,null);
  try{
   const res=await h.request({id,action:'post'});
   expect(res.status,JSON.stringify(res.body)).toBe(422);
   expect(res.body.error?.message).toContain('lockdown');
   expect(await h.status(id)).toBe('draft');
  }finally{await h.lockdown(false,null);}
 });

 it('refuses a closed fiscal period as a 422 naming the period, not a 500',async()=>{
  const id=await h.journal('2026-09-09');
  await h.period('closed');
  try{
   const res=await h.request({id,action:'post'});
   expect(res.status,JSON.stringify(res.body)).toBe(422);
   expect(res.body.error?.message).toContain('closed');
   expect(await h.status(id)).toBe('draft');
  }finally{await h.period('open');}
 });

 it('still posts normally when the period is open and the company is not locked down',async()=>{
  const id=await h.journal('2026-09-09');
  const res=await h.request({id,action:'post'});
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  expect(await h.status(id)).toBe('posted');
 });
});
