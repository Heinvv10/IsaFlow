import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({sql:vi.fn().mockResolvedValue([]),create:vi.fn().mockResolvedValue('batch'),status:vi.fn(),ctx:vi.fn()}));
vi.mock('@/lib/neon',()=>({sql:mocks.sql,withTransaction:vi.fn()}));
vi.mock('@/modules/accounting/services/ap/batchPaymentWriteService',()=>({createControlledBatch:mocks.create,changeBatchStatus:mocks.status}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mocks.ctx}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:vi.fn()}));
import {getBatchById,createBatch,approveBatch} from '@/modules/accounting/services/ap/batchPaymentService';
beforeEach(()=>{vi.clearAllMocks();mocks.sql.mockResolvedValue([]);mocks.ctx.mockReturnValue({principal:{companyId:'company'}});});
it('refuses companyless batch reads without issuing a tenantless query',async()=>{
 await expect(getBatchById('','id')).rejects.toThrow();expect(mocks.sql).not.toHaveBeenCalled();
});
it('delegates creation and status changes to the shared authenticated boundary',async()=>{
 const input={payments:[]};await createBatch('company',input,'person');expect(mocks.create).toHaveBeenCalledWith('company',input,'person');
 await approveBatch('company','batch','person');expect(mocks.status).toHaveBeenCalledWith('company','batch','person','approved');
});
