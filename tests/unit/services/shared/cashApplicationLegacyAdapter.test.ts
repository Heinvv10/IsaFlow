import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({load:vi.fn(),execute:vi.fn(),ctx:{principal:{companyId:'company',personId:'person'}}}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>mocks.ctx}));
vi.mock('@/modules/accounting/services/shared/cashApplicationMaterial',()=>({loadCashApplicationIntent:mocks.load}));
vi.mock('@/modules/accounting/services/shared/cashApplicationControl',()=>({executeCashApplication:mocks.execute}));
import {applyLegacyCashPlan} from '@/modules/accounting/services/shared/cashApplicationLegacyAdapter';
const payment='00000000-0000-4000-8000-000000000001',invoice='00000000-0000-4000-8000-000000000002';
const intent='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004';
const material={plan:{kind:'customer',paymentId:payment,applications:[{invoiceId:invoice,amount:'115.00'}]}};
const plan=()=>({paymentId:payment,lines:[{invoiceId:invoice,amount:115}]});
beforeEach(()=>{vi.clearAllMocks();mocks.load.mockResolvedValue(material);mocks.execute.mockResolvedValue({ok:true});});
it('rejects changing accessor options before loading or executing',async()=>{
 let reads=0;const options={get intentId(){return ++reads<3?intent:other;}};
 await expect(applyLegacyCashPlan('company','person','customer',plan(),options)).rejects.toThrow(/property|descriptor/i);
 expect(reads).toBe(0);expect(mocks.load).not.toHaveBeenCalled();expect(mocks.execute).not.toHaveBeenCalled();
});
it('captures plain caller options and preview before the first await',async()=>{
 const options={intentId:intent,approvalId:intent},preview=plan();
 mocks.load.mockImplementation(async()=>{options.intentId=other;options.approvalId=other;preview.lines[0].amount=1;return material;});
 await expect(applyLegacyCashPlan('company','person','customer',preview,options)).resolves.toEqual({ok:true});
 expect(mocks.execute).toHaveBeenCalledWith(mocks.ctx,intent,{approvalId:intent});
});
it('rejects getter-bearing preview lines without invoking the getter',async()=>{
 let reads=0;const preview={paymentId:payment,lines:[{invoiceId:invoice,get amount(){reads++;return 115;}}]};
 await expect(applyLegacyCashPlan('company','person','customer',preview,{intentId:intent})).rejects.toThrow(/property|descriptor/i);
 expect(reads).toBe(0);expect(mocks.load).not.toHaveBeenCalled();
});
