/**
 * The year-end close consults the LEDGER before it replays its own receipt.
 *
 * The control receipt is keyed on the YEAR ALONE — not on an idempotency key and
 * not on the operation reference of one request — so "the same request again" and
 * "any re-close of this year" are one lookup. Ahead of the ledger it therefore
 * short-circuited every re-close with the ORIGINAL receipt: `alreadyClosed:false`
 * on a call that posted nothing, P&L that landed in the year after the close
 * never reported because `alreadyClosedResult`'s re-read was unreachable, and a
 * REVERSED close answered with a bare `Year closing receipt journal changed`
 * instead of the typed refusal.
 *
 * The four cases below pin the ordering, and — the half that must survive it —
 * that the replay still holds the no-double-post line for the one close the
 * ledger cannot see: a DORMANT year, which locks its periods and writes no
 * journal, so `findClosingJournal` returns null for it forever.
 *
 * These live in the UNIT suite deliberately. The k-046 integration suites prove
 * the same ordering against the real index, but integration does not run in
 * `bun run ci` (it is gated on DATABASE_URL), so a re-ordering regression would
 * reach a PR with the gate green. Companion to
 * `yearEndCloseRace.test.ts`, which pins the race recovery underneath it.
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {YearClosingSources} from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
const m=vi.hoisted(()=>({sql:vi.fn(),load:vi.fn(),permission:vi.fn(),execute:vi.fn(),register:vi.fn(),post:vi.fn(),event:vi.fn(),replay:vi.fn()}));
const COMPANY='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',USER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EFFECT='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
// The replay itself is stubbed: what is under test is WHETHER it is reached, and
// the answer the caller gets when it is not.
vi.mock('@/modules/accounting/services/controls/operationReceiptReplay',()=>({replayKnownOperationEffect:m.replay}));
vi.mock('@/lib/neon',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/neon')>(),sql:m.sql}));
vi.mock('@/lib/logger',()=>({log:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}}));
import {buildYearEndFinancialMaterial} from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
import {closeFiscalYear} from '@/modules/accounting/services/gl/yearEndCloseService';
const ctx={principal:{companyId:COMPANY,personId:USER},sql:m.sql} as unknown as ControlTx;
type Row=Record<string,unknown>;
let source:YearClosingSources,retained:Row[];
/** Whatever rows hold `YE-2027`, as the real table would. */
let ledger:Row[];
/** The control receipt this programme's own earlier close left behind, if any. */
let receipt:{id:string;result:Row}|null;
/** The P&L the LEDGER reports for the year RIGHT NOW — the residual re-read. */
let residual:number;

/** A gl_journal_entries header row as `SELECT *` returns it. */
function header(o:Row={}):Row{return{id:'entry-1',entry_number:'YE-2027',source:'year_end',status:'posted',...o};}

beforeEach(()=>{
 vi.resetAllMocks();
 ledger=[];receipt=null;residual=0;
 source={company:{default_currency:'ZAR',financial_year_start:3},
  periods:[{id:'period',period_name:'March 2026',period_number:1,start_date:'2026-03-01',end_date:'2027-02-28',status:'closed'}],
  journals:[{id:'posted',status:'posted'}],
  accounts:[{id:'rev',account_code:'4000',account_name:'Sales',account_type:'revenue'},{id:'exp',account_code:'5000',account_name:'Wages',account_type:'expense'}],
  lines:[{journal_entry_id:'posted',gl_account_id:'rev',debit:'0',credit:'600000'},{journal_entry_id:'posted',gl_account_id:'exp',debit:'0',credit:'0'}]};
 retained=[{id:'re',account_code:'3200',account_name:'Retained Earnings',account_type:'equity',is_active:true}];
 m.sql.mockImplementation(async(parts:TemplateStringsArray,...args:unknown[])=>{
  const text=parts.join('?');
  if(text.includes('entry_number = '))return ledger.filter(row=>row.entry_number===args[1]);
  // The residual re-read. It is deliberately INDEPENDENT of the material's own
  // netIncome above, so an answer taken from the receipt or from the caller's
  // pre-lookup figure cannot accidentally agree with it.
  if(text.includes("ga.account_type = 'revenue'"))return residual?[{balance:String(residual)}]:[];
  if(text.includes("ga.account_type = 'expense'"))return[];
  if(text.includes('count(*)::int AS n'))return[{n:12}];
  if(text.includes('FROM gl_accounts'))return retained;
  // The receipt is returned only for the key it is actually filed under — the
  // YEAR — so the lookup's own predicate is under test and not just the table it
  // names. Keyed on anything else, the retry finds nothing and closes again.
  if(text.includes('control_operation_effects'))return receipt&&args[1]==='2027'?[receipt]:[];
  if(text.includes('INSERT INTO gl_journal_entries')){
   const row={id:String(args[0]),entry_number:String(args[2]),source:'year_end',status:'draft',fiscal_period_id:args[4]};
   ledger.push(row);return[row];
  }
  if(text.includes('SELECT * FROM gl_journal_entries'))return ledger.filter(row=>row.id===args[1]);
  if(text.includes('UPDATE fiscal_periods'))return[{...source.periods[0],status:'locked'}];
  return[];
 });
 m.load.mockImplementation(async(_ctx:ControlTx,ref:{entityId:string})=>({bindingHash:'binding',binding:{policies:[]},
  observedSources:[{facts:{...source,closing:await buildYearEndFinancialMaterial(ctx,ref.entityId,source)}}]}));
 m.execute.mockImplementation(async(_ctx:unknown,_ref:unknown,_approval:unknown,effect:(p:unknown)=>Promise<unknown>)=>
  effect({accountingDate:'2027-02-28',operationId:'operation'}));
 m.post.mockImplementation(async(_company:string,id:string)=>{
  const row=ledger.find(entry=>entry.id===id);if(row)row.status='posted';});
 m.replay.mockResolvedValue({replayed:true,alreadyClosed:false,closingEntry:header(),netIncome:600000});
});
const close=()=>closeFiscalYear(COMPANY,'2027',USER);
const inserts=()=>m.sql.mock.calls.map(([parts])=>(parts as string[]).join('?'))
 .filter(text=>text.includes('INSERT INTO gl_journal_entries'));

describe('a year this programme already closed, re-closed',()=>{
 beforeEach(()=>{receipt={id:EFFECT,result:{closingEntry:header(),alreadyClosed:false,netIncome:600000}};});

 it('answers from the LEDGER with CURRENT figures, not by replaying the receipt',async()=>{
  // R150 of sales landed in the year AFTER it was closed. The receipt predates
  // that movement, so a replayed answer is silent about it; the ledger re-read
  // is where it shows up, and it must reach the operator as a warning.
  ledger=[header()];residual=150;

  const result=await close() as {alreadyClosed:boolean;closingEntry:Row;netIncome:number;
   unclosedNetIncome:number;periodsLockedInYear:number;message:string};

  expect(result.alreadyClosed).toBe(true);
  expect(result.closingEntry.id).toBe('entry-1');
  expect(result.unclosedNetIncome).toBe(150);
  expect(result.netIncome).toBe(150);
  expect(result.message).toMatch(/WARNING: R150\.00/);
  expect(result.periodsLockedInYear).toBe(12);
  // The receipt was never consulted, and nothing was written.
  expect(m.replay).not.toHaveBeenCalled();
  expect(inserts()).toEqual([]);
  expect(m.execute).not.toHaveBeenCalled();
 });

 it('reports a clean re-close honestly rather than as a fresh success',async()=>{
  // The mirror of the case above, so the fix is shown to fail in both
  // directions: with nothing stranded there is no warning, but the call still
  // says the year was ALREADY closed instead of `alreadyClosed:false` over the
  // original figures.
  ledger=[header()];residual=0;

  const result=await close() as {alreadyClosed:boolean;netIncome:number;message:string};

  expect(result.alreadyClosed).toBe(true);
  expect(result.netIncome).toBe(0);
  expect(result.message).not.toMatch(/WARNING/);
  expect(inserts()).toEqual([]);
 });

 it('gives a REVERSED close the typed refusal, never a bare Error',async()=>{
  // `prior()` re-verifies its receipt's journal with `reversed_at IS NULL` and
  // throws `Year closing receipt journal changed` when it has moved — an
  // untyped 500 for a state `classifyClosingJournal` names precisely.
  ledger=[header({status:'reversed'})];

  const result=await close() as {error:string;entryId:string;entryNumber:string;status:string};

  expect(result.error).toBe('closing_journal_not_posted');
  expect(result.entryId).toBe('entry-1');
  expect(result.entryNumber).toBe('YE-2027');
  expect(result.status).toBe('reversed');
  expect(m.replay).not.toHaveBeenCalled();
  expect(inserts()).toEqual([]);
 });

 it('posts NO second journal for a close whose receipt records none',async()=>{
  // The idempotency the replay actually carries, and the only case that rests
  // on it alone. A DORMANT year closes by locking its periods and writing
  // nothing, so `findClosingJournal` is blind to that close for good — there is
  // no `YE-2027` row to find, now or ever.
  //
  // Then P&L lands in the year. Nothing in the schema refuses a posting into a
  // locked period (k-046's residual tenant proves it on the real table), so the
  // next call loads material with something in it. The ledger says the year is
  // unclosed and the material says there is a journal to write: between them
  // they close the year a SECOND time. The receipt is the only thing that knows
  // better, which is why it is consulted even though the ledger came first.
  //
  // Asserted by COUNTING the INSERTs, not by reading the returned flag: a
  // caller told `alreadyClosed` by a call that posted anyway is the failure
  // this is guarding, so the return value cannot be the evidence.
  receipt={id:EFFECT,result:{closingEntry:null,alreadyClosed:false,netIncome:0}};
  ledger=[];

  const result=await close() as {replayed:boolean};

  expect(inserts()).toEqual([]);
  expect(ledger).toEqual([]);
  expect(m.replay).toHaveBeenCalledTimes(1);
  expect(m.replay.mock.calls[0]![2]).toBe(EFFECT);
  expect(result.replayed).toBe(true);
 });
});

describe('a year that has never been closed',()=>{
 it('closes it: neither the ledger nor a receipt stands in the way',async()=>{
  const result=await close() as {alreadyClosed:boolean;netIncome:number};

  expect(result.alreadyClosed).toBe(false);
  expect(result.netIncome).toBe(600000);
  expect(inserts()).toHaveLength(1);
  expect(m.replay).not.toHaveBeenCalled();
 });
});
