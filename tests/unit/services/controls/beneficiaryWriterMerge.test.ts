import { expect,it,vi } from 'vitest';
import type { PoolClient } from 'pg';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { withControlRequest } from '@/modules/accounting/services/controls/context';
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:vi.fn().mockResolvedValue(null)}));
const source='22222222-2222-4222-8222-222222222222',target='33333333-3333-4333-8333-333333333333',companyId='11111111-1111-4111-8111-111111111111';
const query=vi.fn().mockImplementation(async(text:string)=>({rows:text.includes('SELECT EXISTS')?[{blocked:true}]:[{id:source},{id:target}]}));
const client={query} as unknown as PoolClient;
it('refuses affected supplier merges before any payment reparent or contact mutation',async()=>{
 await expect(withControlRequest({client,userId:'u1',companyId,claims:{}},{personId:'u1',companyId,authMethod:'cookie'},
  ()=>mergeEntities(companyId,'supplier',target,source,'u1'))).rejects.toThrow('SUPPLIER_MERGE_REQUIRES_REVIEW');
 expect(query.mock.calls.some(([text])=>String(text).includes('UPDATE '))).toBe(false);
});
it.each(['purchase_orders','credit_notes'])('refuses standalone %s dependencies before deleting either supplier',async table=>{
 query.mockClear();
 query.mockImplementation(async(text:string)=>({rows:text.includes('SELECT EXISTS')
  ?[{blocked:text.includes(`FROM ${table} WHERE company_id=`)}]
  :text.includes('UPDATE suppliers')?[{id:source}]:[{id:source},{id:target}]}));
 await expect(withControlRequest({client,userId:'u1',companyId,claims:{}},{personId:'u1',companyId,authMethod:'cookie'},
  ()=>mergeEntities(companyId,'supplier',target,source,'u1'))).rejects.toThrow('SUPPLIER_MERGE_REQUIRES_REVIEW');
 expect(query.mock.calls.some(([text])=>String(text).includes('UPDATE suppliers'))).toBe(false);
 if(table==='credit_notes')expect(query.mock.calls.find(([text])=>String(text).includes('SELECT EXISTS'))![0]).toContain("type='supplier'");
});
