import { expect,it,vi } from 'vitest';
import type { PoolClient } from 'pg';
import { importSuppliers } from '@/modules/accounting/services/core/migrationContactService';
import { createSupplier,updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { withControlRequest } from '@/modules/accounting/services/controls/context';
vi.mock('@/modules/accounting/services/core/migrationService',()=>({updateSession:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:vi.fn()}));
vi.mock('@/modules/accounting/services/core/supplierWriteService',()=>({
 createSupplier:vi.fn().mockResolvedValue({id:'new',beneficiary_review:{proposalId:'p1',status:'pending'}}),
 updateSupplier:vi.fn().mockResolvedValue({id:'old',beneficiary_review:{proposalId:'p2',status:'pending'}}) }));
const query=vi.fn().mockResolvedValue({rows:[{id:'old',name:'Existing supplier'}]}),client={query} as unknown as PoolClient;
it('supplier imports converge on the same guarded create/update and surface pending review references',async()=>{
 const result=await withControlRequest({client,userId:'u1',companyId:'c',claims:{}},{personId:'u1',companyId:'c',authMethod:'cookie'},
  ()=>importSuppliers('c','s',[{name:'Existing supplier',bankAccountNumber:'00123456789'},{name:'Distinct new vendor',bankAccountNumber:'00987654321'}],'overwrite'));
 expect(updateSupplier).toHaveBeenCalled();expect(createSupplier).toHaveBeenCalled();
 expect(result).toHaveProperty('beneficiaryReviews',[{supplierId:'old',proposalId:'p2',status:'pending'},{supplierId:'new',proposalId:'p1',status:'pending'}]);
 expect(query.mock.calls.some(([text])=>String(text).includes('UPDATE suppliers'))).toBe(false);
});
