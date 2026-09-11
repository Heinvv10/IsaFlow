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

 /**
  * The tenant-mismatch and assertDirectSource checks in runJournalControl are INTEGRITY checks, not a refusal a
  * caller can safely catch and continue past — a caller that swallows one per row and keeps going
  * (migrationApService.ts, migrationImportService.ts) must not COMMIT whatever it had already written. They stay
  * inside the poisoning try/catch: this route's own catch maps a plain Error to 400, but the override to 500
  * CONTROL_INTEGRITY_FAILED still wins, unlike the period/lockdown precheck above (422, no override).
  */
 it('still answers 500 CONTROL_INTEGRITY_FAILED for a blacklisted generated-journal source, even though this route\'s own catch would otherwise answer 400',async()=>{
  const id=await h.journal('2026-09-09','auto_payment');
  const res=await h.request({id,action:'post'});
  expect(res.status,JSON.stringify(res.body)).toBe(500);
  // withAuth's override body is flat ({success,data,message,code}), NOT the {error:{code,message}} envelope
  // apiResponse.error/badRequest send — a real, distinct wire shape from the route's own 400 it replaced.
  expect(res.body.code).toBe('CONTROL_INTEGRITY_FAILED');
  expect(await h.status(id)).toBe('draft');
 });

 /**
  * The reversal arm of the same precheck: reverseJournalEntry is also a direct (no-parentControl) root call for
  * the ORIGINAL journal.reverse ref, so a lockdown covering the requested reversal_date must refuse 422 the same
  * way — before the controlled write, not from inside assertPostingGuards.
  */
 it('refuses a reversal dated inside the lockdown as a 422, and still reverses once the reversal date is after it',async()=>{
  const id=await h.journal('2026-09-09');
  const posted=await h.request({id,action:'post'});
  expect(posted.status,JSON.stringify(posted.body)).toBe(200);
  await h.lockdown(true,'2026-09-15');
  try{
   const blocked=await h.request({id,action:'reverse',reversal_date:'2026-09-10'});
   expect(blocked.status,JSON.stringify(blocked.body)).toBe(422);
   expect(blocked.body.error?.message).toContain('lockdown');
   expect(await h.state(id)).toMatchObject({status:'posted',reversed_at:null});

   const reversed=await h.request({id,action:'reverse',reversal_date:'2026-09-20'});
   expect(reversed.status,JSON.stringify(reversed.body)).toBe(200);
   expect((await h.state(id))?.reversed_at).not.toBeNull();
  }finally{await h.lockdown(false,null);}
 });
});
