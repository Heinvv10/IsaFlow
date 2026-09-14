/** Preview/writer contracts use actual exact material; transaction mechanics have real PG coverage. */
import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {YearClosingSources} from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
const m=vi.hoisted(()=>({supplied:vi.fn(),sql:vi.fn(),load:vi.fn(),permission:vi.fn(),execute:vi.fn(),register:vi.fn(),post:vi.fn(),event:vi.fn()}));
const COMPANY='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',USER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>ctx,assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:m.permission}));
vi.mock('@/modules/accounting/services/controls/operationMaterializer',()=>({loadOperationMaterial:m.load}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({executeControlledOperation:m.execute,assertSuppliedApprovalExecutable:m.supplied}));
vi.mock('@/modules/accounting/services/controls/generatedJournalPermit',()=>({registerGeneratedJournal:m.register}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService',()=>({postJournalEntry:m.post}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:vi.fn(async()=>null)}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:m.event}));
// The LEDGER lookups — the already-closed journal, the residual re-read, the
// locked-period count — go through the module-level `sql`, which is the same
// transaction client `ctx.sql` runs on (ControlQuery delegates straight to it).
// Pointing both at one mock keeps that true here. importOriginal, so every
// other neon export stays real for the modules that load it.
vi.mock('@/lib/neon',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/neon')>(),sql:m.sql}));
vi.mock('@/lib/logger',()=>({log:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}}));
import {buildYearEndFinancialMaterial} from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
import {closeFiscalYear} from '@/modules/accounting/services/gl/yearEndService';
const ctx={principal:{companyId:COMPANY,personId:USER},sql:m.sql} as unknown as ControlTx;
let source:YearClosingSources,retained:Record<string,unknown>[],entry:Record<string,unknown>,bound=false;
/** Whatever row holds `YE-<year>` in the ledger, and the year's P&L as re-read after that lookup. */
let ledger:Record<string,unknown>[],residual:{revenue:Record<string,unknown>[];expense:Record<string,unknown>[]};
const policies=()=>bound?[{policyId:'policy',requiredRole:'admin'}]:[];
beforeEach(()=>{
 vi.resetAllMocks();entry={};bound=false;ledger=[];residual={revenue:[],expense:[]};
 source={company:{default_currency:'ZAR',financial_year_start:3},periods:[{id:'period',period_name:'March 2026',period_number:1,start_date:'2026-03-01',end_date:'2027-02-28',status:'closed'}],
  journals:[{id:'posted',status:'posted'}],accounts:[{id:'rev',account_code:'4000',account_name:'Sales',account_type:'revenue'},{id:'exp',account_code:'5000',account_name:'Wages',account_type:'expense'}],
  lines:[{journal_entry_id:'posted',gl_account_id:'rev',debit:'0',credit:'1000000'},{journal_entry_id:'posted',gl_account_id:'exp',debit:'400000',credit:'0'}]};
 retained=[{id:'re',account_code:'3200',account_name:'Retained Earnings',account_type:'equity',is_active:true}];
 m.sql.mockImplementation(async(parts:TemplateStringsArray,...args:unknown[])=>{
  const text=parts.join('?');
  // Before the gl_accounts branch: the P&L re-read joins gl_accounts too.
  if(text.includes('entry_number = '))return ledger;
  if(text.includes("ga.account_type = 'revenue'"))return residual.revenue;
  if(text.includes("ga.account_type = 'expense'"))return residual.expense;
  if(text.includes('count(*)::int AS n'))return[{n:12}];
  if(text.includes('FROM gl_accounts'))return retained;
  if(text.includes('control_operation_effects'))return [];
  if(text.includes('INSERT INTO gl_journal_entries')){entry={id:args[0],status:'draft',fiscal_period_id:args[4]};return[entry];}
  if(text.includes('SELECT * FROM gl_journal_entries'))return[entry];
  if(text.includes('UPDATE fiscal_periods'))return[{...source.periods[0],status:'locked'}];
  return [];
 });
 m.load.mockImplementation(async(_ctx:ControlTx,ref:{entityId:string})=>({bindingHash:'binding',binding:{policies:policies()},observedSources:[{facts:{...source,closing:await buildYearEndFinancialMaterial(ctx,ref.entityId,source)}}]}));
 m.execute.mockImplementation(async(_ctx:unknown,_ref:unknown,_approval:unknown,callback:(p:unknown)=>unknown)=>callback({accountingDate:'2027-02-28',operationId:'operation'}));
 m.post.mockImplementation(async()=>{entry={...entry,status:'posted',posted_by:USER,posted_at:'2027-03-01'};});
});
const close=(dryRun=true,year='2027')=>closeFiscalYear(COMPANY,year,USER,{dryRun});
const writes=()=>m.sql.mock.calls.map(([parts])=>(parts as string[]).join('?')).filter(text=>/INSERT|UPDATE|DELETE/.test(text));
describe('financial-year exact preview',()=>{
 it('refuses a preview the kernel would refuse for want of an independent approval, writing nothing',async()=>{
  bound=true;
  expect(await close()).toEqual({error:'approval_required'});
  expect(writes()).toEqual([]);expect(m.execute).not.toHaveBeenCalled();
 });
 it('honours a supplied approval the way the live close does, and refuses one it would reject',async()=>{
  bound=true;m.supplied.mockResolvedValueOnce(undefined);
  expect(await closeFiscalYear(COMPANY,'2027',USER,{dryRun:true,approvalId:'approval'})).toMatchObject({dryRun:true});
  expect(m.supplied).toHaveBeenCalledWith(ctx,{entityType:'fiscal_year',entityId:'2027',operation:'year.close'},'approval');
  m.supplied.mockRejectedValueOnce(new Error('Approval is not executable'));
  await expect(closeFiscalYear(COMPANY,'2027',USER,{dryRun:true,approvalId:'approval'})).rejects.toThrow(/not executable/);
  expect(writes()).toEqual([]);
 });
 it('shows every exact balanced closing line and writes nothing',async()=>{
  const result=await close();expect(result).toMatchObject({dryRun:true,netIncome:600000,netIncomeExact:'600000'});
  if(!('preview'in result))throw new Error('Expected preview');
  expect(result.preview).toMatchObject({entryDate:'2027-02-28',totalDebit:1000000,totalCredit:1000000,exactTotal:'1000000'});
  expect(result.preview.lines).toEqual([
   {accountId:'rev',accountCode:'4000',accountName:'Sales',debit:1000000,credit:0,exactDebit:'1000000',exactCredit:'0'},
   {accountId:'exp',accountCode:'5000',accountName:'Wages',debit:0,credit:400000,exactDebit:'0',exactCredit:'400000'},
   {accountId:'re',accountCode:'3200',accountName:'Retained Earnings',debit:0,credit:600000,exactDebit:'0',exactCredit:'600000'}]);
  expect(writes()).toEqual([]);expect(m.execute).not.toHaveBeenCalled();expect(m.event).not.toHaveBeenCalled();
 });
 it('debits retained earnings for an actual loss',async()=>{
  source.lines[0]!.credit='100';source.lines[1]!.debit='500';
  const result=await close();expect(result).toMatchObject({netIncome:-400});
  if(!('preview'in result))throw new Error('Expected preview');
  expect(result.preview.lines[2]).toMatchObject({accountId:'re',exactDebit:'400',exactCredit:'0'});
 });
 it.each([true,false])('names open periods and refuses without writes (dryRun=%s)',async(dry)=>{
  source.periods[0]!.status='open';
  expect(await close(dry)).toMatchObject({error:'open_periods',count:1,openPeriods:[{periodName:'March 2026'}]});expect(writes()).toEqual([]);
 });
 it('returns missing and contested role diagnostics',async()=>{
  retained=[];expect(await close()).toEqual({error:'no_retained_earnings'});
  retained=[{id:'a',account_code:'3210'},{id:'b',account_code:'3220'}];
  expect(await close()).toEqual({error:'ambiguous_retained_earnings',accountCodes:['3210','3220']});
 });
 it.each([true,false])('refuses wrong fiscal-year ranges with both ranges (dryRun=%s)',async(dry)=>{
  source.periods[0]!.start_date='2026-01-01';source.periods[0]!.end_date='2026-12-31';
  expect(await close(dry,'2026')).toEqual({error:'period_range_mismatch',startMonth:3,expected:{startDate:'2025-03-01',endDate:'2026-02-28'},actual:{startDate:'2026-01-01',endDate:'2026-12-31'}});
  expect(writes()).toEqual([]);
 });
 it('accepts the declared January-start calendar year',async()=>{
  source.company.financial_year_start=1;source.periods[0]!.start_date='2026-01-01';source.periods[0]!.end_date='2026-12-31';
  expect(await close(true,'2026')).toHaveProperty('preview');
 });
 it('refuses unusable fiscal-year basis instead of assuming March',async()=>{
  source.company.financial_year_start=null;await expect(close()).rejects.toThrow('no usable financial_year_start');
 });
 it('returns missing year without a write',async()=>{
  source.periods=[];expect(await close()).toEqual({error:'year_not_found'});expect(writes()).toEqual([]);
 });
 // ── Already closed, read from the LEDGER ────────────────────────────────────
 // The receipt replay in `prior()` only knows closes THIS programme performed.
 // A year closed before the controls existed has no receipt, so without the
 // ledger lookup the close walked past it, wrote a second YE-<year> and died on
 // uq_gl_je_company_entry_number as a raw 23505 → HTTP 500. `control_operation_effects`
 // returns [] throughout these cases: there is no receipt, only a ledger row.
 const closed={id:'je-old',source:'year_end',status:'posted',entry_number:'YE-2027'};
 it('reports a year the LEDGER says is closed, with no control receipt behind it, and writes nothing',async()=>{
  ledger=[closed];
  expect(await close(false)).toMatchObject({alreadyClosed:true,closingEntry:{id:'je-old'},
   periodsLockedInYear:12,netIncome:0,unclosedNetIncome:0});
  expect(writes()).toEqual([]);expect(m.execute).not.toHaveBeenCalled();expect(m.post).not.toHaveBeenCalled();
 });
 it('does not walk past a locked, already-closed year into a second closing journal',async()=>{
  // The periods of a closed year are LOCKED, not 'closed'. Detection has to
  // happen before the eligibility check that insists on 'closed', or the caller
  // gets a thrown 500 instead of the answer.
  ledger=[closed];source.periods[0]!.status='locked';
  expect(await close(false)).toMatchObject({alreadyClosed:true});
  expect(writes()).toEqual([]);
 });
 it('names the residual P&L posted into the year SINCE it closed, which no close can sweep up',async()=>{
  ledger=[closed];
  residual.revenue=[{id:'rev',account_code:'4000',account_name:'Sales',balance:'150'}];
  const result=await close(false) as {unclosedNetIncome:number;netIncome:number;message:string};
  expect(result.unclosedNetIncome).toBe(150);expect(result.netIncome).toBe(150);
  expect(result.message).toMatch(/WARNING/);expect(writes()).toEqual([]);
 });
 it('offers NOTHING on a dry run of a closed year: preview null, the stranded lines named separately',async()=>{
  ledger=[closed];
  const result=await close(true) as {preview:null;residualPreview:{entryNumber:string};alreadyClosed:boolean;
   existingEntry:{id:string};unclosedNetIncome:number};
  expect(result.preview).toBeNull();
  expect(result.alreadyClosed).toBe(true);expect(result.existingEntry.id).toBe('je-old');
  expect(result.residualPreview.entryNumber).toBe('YE-2027');
  expect(result.unclosedNetIncome).toBe(0);expect(writes()).toEqual([]);
 });
 it.each([true,false])('refuses a SQUATTER holding the closing entry number rather than 500ing on it (dryRun=%s)',async(dry)=>{
  ledger=[{id:'je-manual',source:'manual',status:'posted',entry_number:'YE-2027'}];
  expect(await close(dry)).toEqual({error:'closing_entry_number_taken',entryNumber:'YE-2027',
   entryId:'je-manual',source:'manual',status:'posted'});
  expect(writes()).toEqual([]);
 });
 it.each([true,false])('refuses a REVERSED closing journal as not-closed-and-unclosable (dryRun=%s)',async(dry)=>{
  ledger=[{id:'je-rev',source:'year_end',status:'reversed',entry_number:'YE-2027'}];
  expect(await close(dry)).toEqual({error:'closing_journal_not_posted',entryNumber:'YE-2027',
   entryId:'je-rev',status:'reversed'});
  expect(writes()).toEqual([]);
 });
 it('uses controlled posting and final-period association, returning actual posting attribution',async()=>{
  const result=await close(false);
  expect(m.execute).toHaveBeenCalledOnce();expect(m.register).toHaveBeenCalledOnce();expect(m.post).toHaveBeenCalledOnce();
  expect(result).toMatchObject({closingEntry:{status:'posted',posted_by:USER,fiscal_period_id:'period'}});
  const insert=writes().find(text=>text.includes('INSERT INTO gl_journal_entries'))!;
  expect(insert).toContain('fiscal_period_id');expect(insert).not.toMatch(/total_debit|total_credit/);
  expect(insert).toContain("'draft'");expect(writes().some(text=>text.includes('UPDATE fiscal_periods'))).toBe(true);
 });
});
describe('financial-year close under company lockdown (shared lockdownBlock rule)',()=>{
 const locked=(date:string|null)=>{source.company.lockdown_enabled=true;source.company.lockdown_date=date;};
 // The pre-effect read sees the company unlocked; only the live re-read inside the effect sees the lockdown.
 const unlockedFirstRead=()=>m.load.mockImplementationOnce(async(_ctx:ControlTx,ref:{entityId:string})=>({bindingHash:'binding',binding:{policies:[]},
  observedSources:[{facts:{...source,company:{...source.company,lockdown_enabled:false},closing:await buildYearEndFinancialMaterial(ctx,ref.entityId,source)}}]}));
 it('refuses the preview when the closing date is on or before the lockdown date, and allows it the day after',async()=>{
  locked('2027-02-28');await expect(close()).rejects.toThrow('Year-close date is within company lockdown');
  locked('2027-03-31');await expect(close()).rejects.toThrow('Year-close date is within company lockdown');
  locked('2027-02-27');expect(await close()).toHaveProperty('preview');
 });
 it('refuses the preview for every closing date when lockdown is enabled with no date',async()=>{
  locked(null);await expect(close()).rejects.toThrow('Year-close date is within company lockdown');expect(writes()).toEqual([]);
 });
 it('rechecks the lockdown on the live material inside the effect, before any journal is written',async()=>{
  unlockedFirstRead();
  locked(null);await expect(close(false)).rejects.toThrow('Year-close date is within company lockdown');
  expect(m.execute).toHaveBeenCalledOnce();expect(writes()).toEqual([]);expect(m.post).not.toHaveBeenCalled();
 });
 it('rechecks a dated lockdown against the permit date inside the effect',async()=>{
  unlockedFirstRead();
  locked('2027-02-28');await expect(close(false)).rejects.toThrow('Year-close date is within company lockdown');
  expect(writes()).toEqual([]);
 });
});
