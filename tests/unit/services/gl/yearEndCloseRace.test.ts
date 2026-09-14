/**
 * Two people close the same financial year at once.
 *
 * The already-closed lookup is a separate statement from the INSERT, so both
 * callers can read `null` and both reach the write. `uq_gl_je_company_entry_number`
 * keeps the ledger to one journal; what the LOSER must not do is answer HTTP 500
 * for a year that is now correctly closed.
 *
 * These cases used to be driven through master's plain `closeFiscalYear` in
 * `tests/unit/services/yearEndClosePostingGuard.test.ts` (which keeps the
 * poster's own guards). The close is now a CONTROLLED operation, so they are
 * driven at that seam here — same inputs, same result shapes, same refusal
 * names — plus the two the controlled path adds: a real concurrent race, and
 * the proof that a control-integrity failure still poisons rather than being
 * dressed up as a closed year.
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {als} from '@/lib/als';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {YearClosingSources} from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
const m=vi.hoisted(()=>({sql:vi.fn(),load:vi.fn(),permission:vi.fn(),execute:vi.fn(),register:vi.fn(),post:vi.fn(),event:vi.fn()}));
const COMPANY='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',USER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// `assertControlIntegrity` is deliberately NOT mocked: the poison rule is under
// test here, and it is the real function that reads the request store.
vi.mock('@/modules/accounting/services/controls/context',async(importOriginal)=>({
 ...await importOriginal<typeof import('@/modules/accounting/services/controls/context')>(),
 requireControlTx:()=>ctx,assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:m.permission}));
vi.mock('@/modules/accounting/services/controls/operationMaterializer',()=>({loadOperationMaterial:m.load}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({executeControlledOperation:m.execute,assertSuppliedApprovalExecutable:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/generatedJournalPermit',()=>({registerGeneratedJournal:m.register}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService',()=>({postJournalEntry:m.post}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:vi.fn(async()=>null)}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:m.event}));
// The ledger lookups — the already-closed journal, the residual re-read, the
// locked-period count — go through the module-level `sql`, which is the same
// transaction client `ctx.sql` runs on. One mock keeps that true.
vi.mock('@/lib/neon',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/neon')>(),sql:m.sql}));
vi.mock('@/lib/logger',()=>({log:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}}));
import {buildYearEndFinancialMaterial} from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
import {ControlIntegrityError} from '@/modules/accounting/services/controls/context';
import {closeFiscalYear} from '@/modules/accounting/services/gl/yearEndCloseService';
const ctx={principal:{companyId:COMPANY,personId:USER},sql:m.sql} as unknown as ControlTx;
type Row=Record<string,unknown>;
let source:YearClosingSources,retained:Row[];
/** Whatever rows hold `YE-<year>`, as the real table would: the unique index is modelled on this. */
let ledger:Row[],effects:unknown[],insertFails:Error|null;
/**
 * The race WINDOW, opened deterministically the way the integration test opens
 * it (k-046-year-end-squatter-race): the pre-INSERT lookup reads what a caller
 * sees BEFORE the winner commits — nothing — and every later lookup, including
 * the one in the catch that decides what this caller is told, reads the table.
 */
let blindFirstLookup:boolean,lookups:number;

/** A duplicate-key violation shaped exactly like the one the index raises. */
function entryNumberConflict():Error{
 return Object.assign(new Error('duplicate key value violates unique constraint "uq_gl_je_company_entry_number"'),
  {code:'23505',constraint:'uq_gl_je_company_entry_number'});
}
/** A gl_journal_entries header row as `SELECT *` returns it. */
function header(o:Row={}):Row{return{id:'entry-1',entry_number:'YE-2027',source:'year_end',status:'posted',...o};}

beforeEach(()=>{
 vi.resetAllMocks();
 ledger=[];effects=[];insertFails=null;blindFirstLookup=false;lookups=0;
 source={company:{default_currency:'ZAR',financial_year_start:3},
  periods:[{id:'period',period_name:'March 2026',period_number:1,start_date:'2026-03-01',end_date:'2027-02-28',status:'closed'}],
  journals:[{id:'posted',status:'posted'}],
  accounts:[{id:'rev',account_code:'4000',account_name:'Sales',account_type:'revenue'},{id:'exp',account_code:'5000',account_name:'Wages',account_type:'expense'}],
  lines:[{journal_entry_id:'posted',gl_account_id:'rev',debit:'0',credit:'1000000'},{journal_entry_id:'posted',gl_account_id:'exp',debit:'400000',credit:'0'}]};
 retained=[{id:'re',account_code:'3200',account_name:'Retained Earnings',account_type:'equity',is_active:true}];
 m.sql.mockImplementation(async(parts:TemplateStringsArray,...args:unknown[])=>{
  const text=parts.join('?');
  // Before the gl_accounts branch: the P&L re-read joins gl_accounts too.
  if(text.includes('entry_number = ')){
   lookups+=1;
   return blindFirstLookup&&lookups===1?[]:ledger.filter(row=>row.entry_number===args[1]);
  }
  if(text.includes("ga.account_type = 'revenue'"))return[];
  if(text.includes("ga.account_type = 'expense'"))return[];
  if(text.includes('count(*)::int AS n'))return[{n:12}];
  if(text.includes('FROM gl_accounts'))return retained;
  if(text.includes('control_operation_effects'))return[];
  if(text.includes('INSERT INTO gl_journal_entries')){
   if(insertFails)throw insertFails;
   const id=String(args[0]),entryNumber=String(args[2]);
   // The unique index, modelled: one row per (company, entry_number), and the
   // second writer meets it rather than a flag someone set.
   if(ledger.some(row=>row.entry_number===entryNumber))throw entryNumberConflict();
   const row={id,entry_number:entryNumber,source:'year_end',status:'draft',fiscal_period_id:args[4]};
   ledger.push(row);return[row];
  }
  if(text.includes('SELECT * FROM gl_journal_entries'))return ledger.filter(row=>row.id===args[1]);
  if(text.includes('UPDATE fiscal_periods'))return[{...source.periods[0],status:'locked'}];
  return[];
 });
 m.load.mockImplementation(async(_ctx:ControlTx,ref:{entityId:string})=>({bindingHash:'binding',binding:{policies:[]},
  observedSources:[{facts:{...source,closing:await buildYearEndFinancialMaterial(ctx,ref.entityId,source)}}]}));
 // Stands in for the kernel: runs the effect, and records its receipt ONLY when
 // the effect returned — which is what `executeControlledOperation` does, inside
 // the savepoint that takes the loser's permit and observations back with it.
 m.execute.mockImplementation(async(_ctx:unknown,_ref:unknown,_approval:unknown,effect:(p:unknown)=>Promise<unknown>)=>{
  const result=await effect({accountingDate:'2027-02-28',operationId:'operation'});
  effects.push(result);return result;});
 m.post.mockImplementation(async(_company:string,id:string)=>{
  const row=ledger.find(entry=>entry.id===id);if(row)row.status='posted';});
});
const close=()=>closeFiscalYear(COMPANY,'2027',USER);
const writes=()=>m.sql.mock.calls.map(([parts])=>(parts as string[]).join('?')).filter(text=>/INSERT|UPDATE|DELETE/.test(text));

describe('two simultaneous closes: the ledger holds, and the loser tells the truth',()=>{
 it('reports the WINNER as already closed instead of a raw 23505',async()=>{
  // The already-closed lookup is a separate statement from the INSERT, so
  // both callers read `null` and both reach the write. The unique index keeps
  // the ledger to one journal; what the loser must not do is answer 500 for a
  // year that is now correctly closed.
  blindFirstLookup=true;ledger=[header({id:'winner'})];

  const result=await close() as {alreadyClosed:boolean;closingEntry:{id:string};periodsLockedInYear:number};
  // The INSERT really ran and really met the index; the answer comes from the
  // catch's re-read, not from the pre-INSERT lookup.
  expect(writes().filter(text=>text.includes('INSERT INTO gl_journal_entries'))).toHaveLength(1);
  expect(lookups).toBeGreaterThan(1);

  expect(result.alreadyClosed).toBe(true);
  expect(result.closingEntry.id).toBe('winner');
  expect(result.periodsLockedInYear).toBe(12);
  // Re-read AFTER the winner's journal exists, not taken from the netIncome
  // this call computed before it: the loser must not report the P&L the
  // winner has just moved into equity as money left outside it.
  expect((result as unknown as {unclosedNetIncome:number}).unclosedNetIncome).toBe(0);
  // The loser records NOTHING — no receipt claiming it closed the year.
  expect(effects).toEqual([]);
 });

 it('REFUSES BY NAME when a squatter took the number between the lookup and the INSERT',async()=>{
  // A squatter that appeared in that window is not a close, and calling it
  // one would be the lie the branch exists to avoid — but rethrowing the
  // 23505 answers HTTP 500 "Failed to process year-end", which is the exact
  // opacity `closing_entry_number_taken` was written to remove. It differs
  // from the squatter the lookup catches only in timing, so it earns the
  // same typed refusal.
  blindFirstLookup=true;ledger=[header({id:'squatter',source:'manual'})];

  const result=await close() as {error:string;entryId:string;source:string;status:string;entryNumber:string};

  expect(result.error).toBe('closing_entry_number_taken');
  expect(result.entryId).toBe('squatter');
  expect(result.source).toBe('manual');
  expect(result.entryNumber).toBe('YE-2027');
  expect(effects).toEqual([]);
 });

 it('REFUSES a DRAFT year_end winner as not-posted rather than reporting the year closed',async()=>{
  // A draft or reversed `year_end` row holding the number means the year is
  // NOT closed and cannot be closed while it sits there. Reporting it as
  // alreadyClosed would lie twice: nothing was posted, and nothing ever will
  // be until a person renumbers it.
  blindFirstLookup=true;ledger=[header({id:'draft-close',status:'draft'})];

  const result=await close() as {error:string;entryId:string;status:string};

  expect(result.error).toBe('closing_journal_not_posted');
  expect(result.entryId).toBe('draft-close');
  expect(result.status).toBe('draft');
 });

 it('RETHROWS the 23505 when NOTHING holds the number on the re-read',async()=>{
  // Then the conflict is not the one this branch explains — the row was
  // deleted, or the violation came from somewhere else entirely — and
  // dressing it up as a closed year would report a close that never happened.
  insertFails=entryNumberConflict();

  await expect(close()).rejects.toThrow(/uq_gl_je_company_entry_number/);
 });

 it('RETHROWS a failure that is not the entry-number conflict',async()=>{
  insertFails=Object.assign(new Error('deadlock detected'),{code:'40P01'});

  await expect(close()).rejects.toThrow(/deadlock detected/);
 });

 it('lets ONE of two concurrent closers write the journal and tells the other the year is closed',async()=>{
  // The race itself, not a conflict someone armed: both calls read the empty
  // lookup, both reach the INSERT, and the modelled unique index decides.
  const [first,second]=await Promise.all([close(),close()]) as Array<Record<string,unknown>>;
  const outcomes=[first,second];
  const winner=outcomes.find(result=>result.alreadyClosed===false)!;
  const loser=outcomes.find(result=>result.alreadyClosed===true)!;

  expect(winner).toBeDefined();expect(loser).toBeDefined();
  // ONE closing journal in the ledger, and it is the winner's.
  expect(ledger.filter(row=>row.entry_number==='YE-2027')).toHaveLength(1);
  expect((winner.closingEntry as Row).id).toBe(ledger[0]!.id);
  expect((loser.closingEntry as Row).id).toBe(ledger[0]!.id);
  expect(loser.unclosedNetIncome).toBe(0);
  // One receipt, for the operation that actually closed the year.
  expect(effects).toHaveLength(1);
  // And the loser locked nothing: the irreversible half never ran for it.
  expect(writes().filter(text=>text.includes('UPDATE fiscal_periods'))).toHaveLength(source.periods.length);
 });
});

describe('a journal of ANOTHER source holding YE-<year> is a typed refusal, not a 500',()=>{
 it('names the squatting journal and writes nothing',async()=>{
  // uq_gl_je_company_entry_number has no predicate on source, so a manual
  // journal numbered YE-2027 blocks the INSERT just as hard as a real close.
  ledger=[header({id:'squatter',source:'manual',status:'posted'})];

  const result=await close() as {error:string;entryId:string;source:string;status:string;entryNumber:string};

  expect(result.error).toBe('closing_entry_number_taken');
  expect(result.entryId).toBe('squatter');
  expect(result.source).toBe('manual');
  expect(result.entryNumber).toBe('YE-2027');
  // The refusal lands before the kernel is entered at all: no permit, no
  // journal, and above all no period lock, which is the irreversible half.
  expect(m.execute).not.toHaveBeenCalled();
  expect(writes()).toEqual([]);
 });
});

describe('the recognised conflict never outranks a control-integrity failure',()=>{
 const store=(controlWriteFailed:boolean)=>({client:{} as never,userId:USER,companyId:COMPANY,claims:{},controlWriteFailed});

 it('answers CONTROL_INTEGRITY_FAILED, not "already closed", when a control write failed in the request',async()=>{
  // The whole point of the poison: a handler cannot return success after its
  // evidence failed to commit. A 23505 the caller could otherwise be told
  // about honestly does not buy its way past that.
  blindFirstLookup=true;ledger=[header({id:'winner'})];

  await expect(als.run(store(true),close)).rejects.toBeInstanceOf(ControlIntegrityError);
 });

 it('still answers the loser honestly when nothing poisoned the request',async()=>{
  // The mirror of the case above, so the guard is shown to fail in both
  // directions rather than just refusing everything.
  blindFirstLookup=true;ledger=[header({id:'winner'})];

  const result=await als.run(store(false),close) as {alreadyClosed:boolean};
  expect(result.alreadyClosed).toBe(true);
 });

 it('rethrows a failed effect write untouched instead of converting it',async()=>{
  // A change-event write that fails is an integrity failure, not a data-state
  // refusal: it poisons in its own module and must reach the caller as itself.
  m.event.mockRejectedValue(new Error('Control change could not be recorded'));

  await expect(close()).rejects.toThrow('Control change could not be recorded');
  expect(effects).toEqual([]);
 });

 it('refuses a close whose actor does not match the authenticated context',async()=>{
  await expect(closeFiscalYear('dddddddd-dddd-4ddd-8ddd-dddddddddddd','2027',USER))
   .rejects.toThrow('Year-close actor does not match authenticated context');
  expect(m.execute).not.toHaveBeenCalled();expect(writes()).toEqual([]);
 });
});
