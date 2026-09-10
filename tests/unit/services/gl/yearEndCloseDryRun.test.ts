/** Preview/writer contracts use actual exact material; transaction mechanics have real PG coverage. */
import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {YearClosingSources} from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
const m=vi.hoisted(()=>({sql:vi.fn(),load:vi.fn(),permission:vi.fn(),execute:vi.fn(),register:vi.fn(),post:vi.fn(),event:vi.fn()}));
const COMPANY='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',USER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>ctx,assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:m.permission}));
vi.mock('@/modules/accounting/services/controls/operationMaterializer',()=>({loadOperationMaterial:m.load}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({executeControlledOperation:m.execute}));
vi.mock('@/modules/accounting/services/controls/generatedJournalPermit',()=>({registerGeneratedJournal:m.register}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService',()=>({postJournalEntry:m.post}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:vi.fn(async()=>null)}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:m.event}));
import {buildYearEndFinancialMaterial} from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
import {closeFiscalYear} from '@/modules/accounting/services/gl/yearEndService';
const ctx={principal:{companyId:COMPANY,personId:USER},sql:m.sql} as unknown as ControlTx;
let source:YearClosingSources,retained:Record<string,unknown>[],entry:Record<string,unknown>,bound=false;
const policies=()=>bound?[{policyId:'policy',requiredRole:'admin'}]:[];
beforeEach(()=>{
 vi.resetAllMocks();entry={};bound=false;
 source={company:{default_currency:'ZAR',financial_year_start:3},periods:[{id:'period',period_name:'March 2026',period_number:1,start_date:'2026-03-01',end_date:'2027-02-28',status:'closed'}],
  journals:[{id:'posted',status:'posted'}],accounts:[{id:'rev',account_code:'4000',account_name:'Sales',account_type:'revenue'},{id:'exp',account_code:'5000',account_name:'Wages',account_type:'expense'}],
  lines:[{journal_entry_id:'posted',gl_account_id:'rev',debit:'0',credit:'1000000'},{journal_entry_id:'posted',gl_account_id:'exp',debit:'400000',credit:'0'}]};
 retained=[{id:'re',account_code:'3200',account_name:'Retained Earnings',account_type:'equity',is_active:true}];
 m.sql.mockImplementation(async(parts:TemplateStringsArray,...args:unknown[])=>{
  const text=parts.join('?');
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
 it('uses controlled posting and final-period association, returning actual posting attribution',async()=>{
  const result=await close(false);
  expect(m.execute).toHaveBeenCalledOnce();expect(m.register).toHaveBeenCalledOnce();expect(m.post).toHaveBeenCalledOnce();
  expect(result).toMatchObject({closingEntry:{status:'posted',posted_by:USER,fiscal_period_id:'period'}});
  const insert=writes().find(text=>text.includes('INSERT INTO gl_journal_entries'))!;
  expect(insert).toContain('fiscal_period_id');expect(insert).not.toMatch(/total_debit|total_credit/);
  expect(insert).toContain("'draft'");expect(writes().some(text=>text.includes('UPDATE fiscal_periods'))).toBe(true);
 });
});
