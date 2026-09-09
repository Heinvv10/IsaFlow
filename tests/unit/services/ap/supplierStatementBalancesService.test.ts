import {mockUnsafe,recordSqlCall} from '../../helpers/sqlFragmentMock';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/neon',()=>({sql:Object.assign(vi.fn(),{unsafe:mockUnsafe})}));
vi.mock('@/modules/accounting/services/ap/apAgingService',()=>({getAPAging:vi.fn()}));
import {sql} from '@/lib/neon';
import {getAPAging} from '@/modules/accounting/services/ap/apAgingService';
import {getSupplierStatementBalances} from '@/modules/accounting/services/ap/supplierStatementBalancesService';
const companyId='11111111-1111-4111-9111-111111111111';
beforeEach(()=>vi.resetAllMocks());
it('deducts unapplied credits once while preserving every ageing bucket',async()=>{
 vi.mocked(getAPAging).mockResolvedValue([{entityId:'s1',entityName:'Cable Feeder',current:5844901.36,days30:0,days60:0,days90:0,days120Plus:0,total:5844901.36}]);
 vi.mocked(sql).mockResolvedValue([{entity_id:'s1',entity_name:'Cable Feeder',on_account:'884343.60'}]);
 const [balance]=await getSupplierStatementBalances(companyId,'2026-09-09');
 expect(balance).toMatchObject({current:5844901.36,total:5844901.36,onAccount:884343.60,netBalance:4960557.76});
 expect(getAPAging).toHaveBeenCalledWith(companyId,'2026-09-09');
});
it('includes suppliers with only payments or credits on account as credit balances',async()=>{
 vi.mocked(getAPAging).mockResolvedValue([]);
 vi.mocked(sql).mockResolvedValue([{entity_id:'s1',entity_name:'Credit supplier',on_account:'125.50'}]);
 expect(await getSupplierStatementBalances(companyId,'2026-09-09')).toEqual([expect.objectContaining({entityId:'s1',total:0,current:0,onAccount:125.5,netBalance:-125.5})]);
});
it('queries company-scoped live allocation and credit sources through the same cutoff',async()=>{
 vi.mocked(getAPAging).mockResolvedValue([]);
 vi.mocked(sql).mockResolvedValue([]);
 await getSupplierStatementBalances(companyId,'2026-08-31');
 const [strings,...raw]=vi.mocked(sql).mock.calls[0]!;
 // recordSqlCall splices the as-at fragment exactly as the real client does,
 // so `query` and `values` are what Postgres would have been sent.
 const {sql:query,values}=recordSqlCall(strings,raw);
 expect(query).toContain('payment_allocations');
 expect(query).not.toContain('supplier_payment_allocations');
 expect(query).toContain('applied_amount');
 expect(query).toContain('si.company_id');
 expect(query).toContain('sp.company_id');
 expect(query).toContain('cn.company_id');
 expect(values).toContain(companyId);
 expect(values).toContain('2026-08-31');
});
