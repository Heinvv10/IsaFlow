import {beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
const mocks=vi.hoisted(()=>({bankSources:vi.fn(),bankOriginal:vi.fn(),cashSources:vi.fn(),cashOriginal:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:()=>undefined}));
vi.mock('@/modules/accounting/services/bank/bankAllocationPlan',async original=>({...await original<object>(),
 parseBankAllocationPlan:()=>({kind:'customer',bankTransactionId:TX,partyId:PARTY,applications:[]})}));
vi.mock('@/modules/accounting/services/bank/bankAllocationSources',()=>({loadBankAllocationSources:mocks.bankSources}));
vi.mock('@/modules/accounting/services/bank/bankAllocationReversalSources',async original=>({...await original<object>(),loadBankAllocationOriginal:mocks.bankOriginal}));
vi.mock('@/modules/accounting/services/shared/cashApplicationPlan',async original=>({...await original<object>(),
 parseCashApplicationPlan:()=>({version:1,kind:'customer',paymentId:PAYMENT,accountingDate:'2026-09-10',applications:[{invoiceId:INVOICE,amount:'115.00'}]}),cashApplicationTotal:()=>'115.00'}));
vi.mock('@/modules/accounting/services/shared/cashApplicationSources',()=>({loadCashApplicationSources:mocks.cashSources}));
vi.mock('@/modules/accounting/services/shared/cashApplicationReversalSources',async original=>({...await original<object>(),loadOriginalCashApplication:mocks.cashOriginal}));
vi.mock('@/modules/accounting/services/controls/payrollCompensationPlan',async original=>({...await original<object>(),parsePayrollCompensationPayload:()=>({version:1,source:{kind:'manual'},actions:[]})}));
vi.mock('@/modules/accounting/services/controls/payrollCompensationSource',async original=>({...await original<object>(),
 loadPayrollCompensationSources:async()=>({assignments:[]}),compensationFingerprint:()=>'fp'}));
import {loadBankAllocationIntent} from '@/modules/accounting/services/bank/bankAllocationMaterial';
import {loadBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversalMaterial';
import {loadCashApplicationIntent} from '@/modules/accounting/services/shared/cashApplicationMaterial';
import {loadCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalMaterial';
import {loadPayrollCompensationIntent} from '@/modules/accounting/services/controls/payrollCompensationMaterial';
const TX='00000000-0000-4000-8000-0000000000a1',PARTY='00000000-0000-4000-8000-0000000000a2',PAYMENT='00000000-0000-4000-8000-0000000000a3';
const INVOICE='00000000-0000-4000-8000-0000000000a4',JOURNAL='00000000-0000-4000-8000-0000000000a5',LINE='00000000-0000-4000-8000-0000000000a6';
const ORIGINAL='00000000-0000-4000-8000-0000000000a7',id='abcdefab-cdef-4abc-8def-abcdefabcdef',UPPER=id.toUpperCase();
type Rows=Record<string,unknown>[];
let routes:Array<[RegExp,Rows]>=[];
const sql=vi.fn(async(strings:TemplateStringsArray)=>{const text=strings.join('?');return routes.find(([pattern])=>pattern.test(text))?.[1]??[];});
const ctx={principal:{companyId:'00000000-0000-4000-8000-000000000001',personId:'00000000-0000-4000-8000-000000000002'},sql} as unknown as ControlTx;
const receipt=(result:Record<string,unknown>,effectId='00000000-0000-4000-8000-0000000000e1')=>({id:effectId,result});
const dual=(result:Record<string,unknown>)=>[receipt(result),receipt(result,'00000000-0000-4000-8000-0000000000e2')];
const bankIntent={id,payload:{},bank_transaction_id:TX,amount:'115.00',accounting_date:'2026-09-09',source_fingerprint:'fp'};
const cashIntent={id,payload:{},payment_id:PAYMENT,kind:'customer',accounting_date:'2026-09-10',amount:'115.00',currency:'ZAR',source_fingerprint:'fp'};
const reversalIntent={id,original_intent_id:ORIGINAL,bank_transaction_id:TX,reversal_date:'2026-09-11'};
function using(intents:Array<[RegExp,Rows]>,effects:Rows){routes=[[/control_operation_effects/,effects],...intents,[/gl_journal_entries je JOIN/,[{id:JOURNAL}]]];}
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.bankSources.mockResolvedValue({fingerprint:'fp',bank:{status:'allocated',matched_journal_line_id:LINE,amount:'999',transaction_date:'2026-09-09'}});
 mocks.cashSources.mockResolvedValue({fingerprint:'fp',allocations:[],invoices:[]});
 mocks.bankOriginal.mockResolvedValue({plan:{bankTransactionId:TX},journal:{id:JOURNAL,reversed_at:null},sources:{bank:{status:'imported'}},lines:[]});
 mocks.cashOriginal.mockResolvedValue({plan:{accountingDate:'2026-09-10'},rows:[{reversed_at:'2026-09-11T00:00:00Z',reversal_intent_id:id}]});
});
const allocation={intentId:id,journalEntryId:JOURNAL,afterFingerprint:'fp'};
it('bank allocation refuses two case-variant receipts for one intent',async()=>{
 using([[/control_bank_allocation_intents/,[bankIntent]]],dual(allocation));
 await expect(loadBankAllocationIntent(ctx,id)).rejects.toThrow('Ambiguous operation receipt');
});
it('bank allocation accepts a legacy receipt whose result spells the intent in uppercase',async()=>{
 using([[/control_bank_allocation_intents/,[bankIntent]]],[receipt({...allocation,intentId:UPPER})]);
 await expect(loadBankAllocationIntent(ctx,id)).resolves.toMatchObject({effect:{result:{intentId:UPPER}}});
});
it('bank reversal refuses two case-variant receipts for one intent',async()=>{
 using([[/control_bank_allocation_reversal_intents/,[reversalIntent]]],dual({intentId:id,afterFingerprint:'fp',reversalJournalEntryId:JOURNAL}));
 await expect(loadBankAllocationReversal(ctx,id)).rejects.toThrow('Ambiguous operation receipt');
});
it('cash application refuses two case-variant receipts for one intent',async()=>{
 using([[/control_cash_application_intents/,[cashIntent]]],dual({intentId:id,afterFingerprint:'fp'}));
 await expect(loadCashApplicationIntent(ctx,id)).rejects.toThrow('Ambiguous operation receipt');
});
it('cash reversal refuses two case-variant receipts for one intent',async()=>{
 using([[/control_cash_application_reversal_intents/,[reversalIntent]]],dual({intentId:id,afterFingerprint:'fp'}));
 await expect(loadCashApplicationReversal(ctx,id)).rejects.toThrow('Ambiguous operation receipt');
});
it('cash reversal accepts a legacy receipt whose result spells the intent in uppercase',async()=>{
 const original=await mocks.cashOriginal(),fingerprint=createHash('sha256').update(canonicalJson({intent:reversalIntent,original,periods:[],vatLocks:[]})).digest('hex');
 using([[/control_cash_application_reversal_intents/,[reversalIntent]]],[receipt({intentId:UPPER,afterFingerprint:fingerprint})]);
 await expect(loadCashApplicationReversal(ctx,id)).resolves.toMatchObject({effect:{result:{intentId:UPPER}}});
});
it('compensation refuses two case-variant receipts for one intent',async()=>{
 using([[/control_payroll_compensation_intents/,[{id,source_fingerprint:'fp'}]]],dual({intentId:id,afterFingerprint:'fp'}));
 await expect(loadPayrollCompensationIntent(ctx,id)).rejects.toThrow('Ambiguous operation receipt');
});
it('compensation accepts a legacy receipt whose result spells the intent in uppercase',async()=>{
 using([[/control_payroll_compensation_intents/,[{id,source_fingerprint:'fp'}]]],[receipt({intentId:UPPER,afterFingerprint:'fp'})]);
 await expect(loadPayrollCompensationIntent(ctx,id)).resolves.toMatchObject({effect:{result:{intentId:UPPER}}});
});
const bankOriginal=async()=>(await vi.importActual<typeof import('@/modules/accounting/services/bank/bankAllocationReversalSources')>('@/modules/accounting/services/bank/bankAllocationReversalSources')).loadBankAllocationOriginal;
const cashOriginal=async()=>(await vi.importActual<typeof import('@/modules/accounting/services/shared/cashApplicationReversalSources')>('@/modules/accounting/services/shared/cashApplicationReversalSources')).loadOriginalCashApplication;
it('original bank allocation lookup refuses two case-variant receipts',async()=>{
 using([[/control_bank_allocation_intents/,[bankIntent]]],dual({intentId:id,journalEntryId:JOURNAL,paymentId:null}));
 await expect((await bankOriginal())(ctx,id)).rejects.toThrow('Ambiguous operation receipt');
});
it('original bank allocation lookup accepts an uppercase legacy receipt and proceeds to source proof',async()=>{
 using([[/control_bank_allocation_intents/,[bankIntent]]],[receipt({intentId:UPPER,journalEntryId:JOURNAL,paymentId:null})]);
 await expect((await bankOriginal())(ctx,id)).rejects.toThrow('Original bank source changed');
});
const cashEffect={intentId:id,paymentId:PAYMENT,amount:'115.00',allocationIds:['00000000-0000-4000-8000-0000000000b1']};
it('original cash application lookup refuses two case-variant receipts',async()=>{
 using([[/control_cash_application_intents/,[cashIntent]]],dual(cashEffect));
 await expect((await cashOriginal())(ctx,id)).rejects.toThrow('Ambiguous operation receipt');
});
it('original cash application lookup accepts an uppercase legacy receipt and proceeds to row lineage proof',async()=>{
 using([[/control_cash_application_intents/,[cashIntent]]],[receipt({...cashEffect,intentId:UPPER})]);
 await expect((await cashOriginal())(ctx,id)).rejects.toThrow('Original cash application row lineage changed');
});
