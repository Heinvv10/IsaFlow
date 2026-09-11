/** All four cash application writers refuse through the shared lockdownBlock rule (unmocked): prepare and effect, apply and reverse. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {ControlledEffectPermit} from '@/modules/accounting/services/controls/approvalExecutionService';
const m=vi.hoisted(()=>({sql:vi.fn(),sources:vi.fn(),intent:vi.fn(),reversal:vi.fn(),reversible:vi.fn(),event:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:vi.fn()}));
vi.mock('@/lib/neon',()=>({withSavepoint:(_name:string,fn:()=>unknown)=>fn()}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({assertControlledEffectPermit:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:m.event}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:vi.fn(async()=>null)}));
vi.mock('@/modules/accounting/services/shared/cashApplicationSources',()=>({loadCashApplicationSources:m.sources}));
vi.mock('@/modules/accounting/services/shared/cashApplicationMaterial',()=>({loadCashApplicationIntent:m.intent}));
vi.mock('@/modules/accounting/services/shared/cashApplicationReversalMaterial',()=>({loadCashApplicationReversal:m.reversal}));
vi.mock('@/modules/accounting/services/shared/cashApplicationReversalSources',()=>({assertCashApplicationReversible:m.reversible}));
import {prepareCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {executeCashApplicationEffect} from '@/modules/accounting/services/shared/cashApplicationEffect';
import {prepareCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {executeCashApplicationReversalEffect} from '@/modules/accounting/services/shared/cashApplicationReversalEffect';
const COMPANY='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',PAYMENT='dddddddd-dddd-4ddd-8ddd-dddddddddddd',INVOICE='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',INTENT='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ctx={principal:{companyId:COMPANY,personId:'person'},sql:m.sql} as unknown as ControlTx;
let ledger:Record<string,unknown>;
const plan=(accountingDate:string)=>({version:1,kind:'customer',paymentId:PAYMENT,accountingDate,applications:[{invoiceId:INVOICE,amount:'10.00'}]});
const sources=()=>({ledger,periods:[{id:'period',status:'open'}],vatLocks:[],allocations:[],payment:{id:PAYMENT,total_amount:'100.00'},
 invoices:[{invoice:{id:INVOICE,amount_paid:'0',total_amount:'50.00'},allocation:{invoiceId:INVOICE,amount:'10.00'}}],fingerprint:'fp'});
const permit=(accountingDate:string,operation='cash_application.apply')=>({accountingDate,operationId:'operation',entityType:'x',entityId:INTENT,operation} as unknown as ControlledEffectPermit);
const writes=()=>m.sql.mock.calls.map(([parts])=>(parts as string[]).join('?')).filter(text=>/INSERT|UPDATE|DELETE/.test(text));
beforeEach(()=>{
 vi.resetAllMocks();ledger={id:COMPANY,default_currency:'ZAR',lockdown_enabled:true,lockdown_date:'2026-09-15'};
 m.sql.mockResolvedValue([{id:'row'}]);m.sources.mockImplementation(async()=>sources());
 m.intent.mockImplementation(async()=>({intent:{id:INTENT},plan:plan('2026-09-01'),sources:sources(),effect:null}));
 m.reversible.mockImplementation(async()=>({intent:{id:INTENT},plan:plan('2026-09-01'),sources:sources(),rows:[],effect:{result:{allocationIds:[]}}}));
 m.reversal.mockImplementation(async()=>({intent:{id:INTENT,original_intent_id:INTENT},periods:[{id:'period',status:'open'}],vatLocks:[],effect:null,fingerprint:'fp'}));
});
describe('prepareCashApplication',()=>{
 it('refuses on or before a dated lockdown, allows the day after',async()=>{
  await expect(prepareCashApplication(ctx,plan('2026-09-15'))).rejects.toThrow('Cash application date is within company lockdown');
  await expect(prepareCashApplication(ctx,plan('2026-09-14'))).rejects.toThrow('Cash application date is within company lockdown');
  expect(writes()).toEqual([]);
  await expect(prepareCashApplication(ctx,plan('2026-09-16'))).resolves.toHaveProperty('intentId');
 });
 it('refuses every date when lockdown is enabled with no date',async()=>{
  ledger.lockdown_date=null;await expect(prepareCashApplication(ctx,plan('2099-12-31'))).rejects.toThrow('Cash application date is within company lockdown');
 });
});
describe('executeCashApplicationEffect',()=>{
 const ref={entityType:'cash_application_intent',entityId:INTENT,operation:'cash_application.apply' as const};
 it('refuses a permit date on or before a dated lockdown before any allocation row, allows the day after',async()=>{
  await expect(executeCashApplicationEffect(ctx,ref,permit('2026-09-15'))).rejects.toThrow('Cash application date is locked');
  await expect(executeCashApplicationEffect(ctx,ref,permit('2026-09-14'))).rejects.toThrow('Cash application date is locked');
  expect(writes()).toEqual([]);
  await expect(executeCashApplicationEffect(ctx,ref,permit('2026-09-16'))).resolves.toHaveProperty('allocationIds');
 });
 it('refuses every permit date when lockdown is enabled with no date',async()=>{
  ledger.lockdown_date=null;await expect(executeCashApplicationEffect(ctx,ref,permit('2099-12-31'))).rejects.toThrow('Cash application date is locked');
 });
});
describe('prepareCashApplicationReversal',()=>{
 const input=(reversalDate:string)=>({originalIntentId:INTENT,reversalDate,reason:'synthetic'});
 it('refuses a reversal date on or before a dated lockdown, allows the day after',async()=>{
  await expect(prepareCashApplicationReversal(ctx,input('2026-09-15'))).rejects.toThrow('Cash reversal date is locked');
  await expect(prepareCashApplicationReversal(ctx,input('2026-09-14'))).rejects.toThrow('Cash reversal date is locked');
  expect(m.event).not.toHaveBeenCalled();
  await expect(prepareCashApplicationReversal(ctx,input('2026-09-16'))).resolves.toHaveProperty('intentId');
 });
 it('refuses every reversal date when lockdown is enabled with no date',async()=>{
  ledger.lockdown_date=null;await expect(prepareCashApplicationReversal(ctx,input('2099-12-31'))).rejects.toThrow('Cash reversal date is locked');
 });
});
describe('executeCashApplicationReversalEffect',()=>{
 const ref={entityType:'cash_application_reversal_intent',entityId:INTENT,operation:'cash_application.reverse' as const};
 it('refuses a permit date on or before a dated lockdown before any row is reversed, allows the day after',async()=>{
  await expect(executeCashApplicationReversalEffect(ctx,ref,permit('2026-09-15'))).rejects.toThrow('Cash reversal date is locked');
  await expect(executeCashApplicationReversalEffect(ctx,ref,permit('2026-09-14'))).rejects.toThrow('Cash reversal date is locked');
  expect(writes()).toEqual([]);
  await expect(executeCashApplicationReversalEffect(ctx,ref,permit('2026-09-16','cash_application.reverse'))).resolves.toBeDefined();
 });
 it('refuses every permit date when lockdown is enabled with no date',async()=>{
  ledger.lockdown_date=null;await expect(executeCashApplicationReversalEffect(ctx,ref,permit('2099-12-31'))).rejects.toThrow('Cash reversal date is locked');
 });
});
