import {expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {listOperationApprovals} from '@/modules/accounting/services/controls/approvalReadService';
const company='11111111-1111-4111-8111-111111111111',person='22222222-2222-4222-8222-222222222222';
it('refuses an unissued approval reader context',async()=>{
 await expect(listOperationApprovals({} as never,{})).rejects.toThrow(/control|authenticated/i);
});
for(const options of [{limit:0},{limit:101},{limit:1.5},{cursor:'x'.repeat(2049)},{status:'expired'},{companyId:company}])it(`rejects malformed bounded options ${JSON.stringify(options).slice(0,60)} before SQL`,async()=>{
 const query=vi.fn(),client={query} as unknown as PoolClient;
 await withControlRequest({client,userId:person,companyId:company,claims:{}},{personId:person,companyId:company,authMethod:'cookie'},async()=>{
  const {requireControlTx}=await import('@/modules/accounting/services/controls/context');
  await expect(listOperationApprovals(requireControlTx(),options as never)).rejects.toThrow();
 });
 expect(query).not.toHaveBeenCalled();
});
