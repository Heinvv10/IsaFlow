import {expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({ctx:vi.fn(),permission:vi.fn(),load:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:mocks.ctx}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/ap/paymentBatchSource',()=>({loadPreparedBatch:mocks.load,loadBatchBankAccount:vi.fn()}));
import {createPaymentReleaseIntent} from '@/modules/accounting/services/ap/paymentReleaseService';
it('release requires its own current permission before bank payload access',async()=>{
 mocks.permission.mockRejectedValue(new Error('release denied'));
 await expect(createPaymentReleaseIntent({principal:{companyId:'company'}} as never,{batchId:'11111111-1111-4111-8111-111111111111',channel:'netcash'})).rejects.toThrow('release denied');
 expect(mocks.permission).toHaveBeenCalledWith(expect.anything(),'write:release');expect(mocks.load).not.toHaveBeenCalled();
});
