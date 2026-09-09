import { expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
const mocks=vi.hoisted(()=>({prepare:vi.fn(async()=>({intentId:'intent',status:'approval_required',requiresApproval:true})),execute:vi.fn(),sql:vi.fn(async()=>[])}));
vi.mock('@/modules/accounting/services/bank/bankTransferPostingService',()=>({prepareBankTransfer:mocks.prepare,executeBankTransfer:mocks.execute}));
vi.mock('@/lib/neon',()=>({sql:mocks.sql,withTransaction:vi.fn()}));
vi.mock('@/lib/auth',()=>({withAuth:(x:unknown)=>x,withWriteAccess:(x:unknown)=>x}));
vi.mock('@/lib/auth/withCsrf',()=>({withCsrf:(x:unknown)=>x}));
vi.mock('@/lib/api-error-handler',()=>({withErrorHandler:(x:unknown)=>x}));
import handler from '../../../../pages/api/accounting/bank-transfers';
it('prepares a durable reviewable transfer instead of posting SQL from the route',async()=>{
 const req={method:'POST',companyId:'company',user:{id:'person'},body:{
  fromAccountId:'11111111-1111-1111-1111-111111111111',toAccountId:'22222222-2222-2222-2222-222222222222',amount:'100.01',transferDate:'2026-02-28',
 }} as unknown as NextApiRequest;
 const response={status:vi.fn(),json:vi.fn(),setHeader:vi.fn()};response.status.mockReturnValue(response);
 await handler(req,response as unknown as NextApiResponse);
 expect(mocks.prepare).toHaveBeenCalledOnce();expect(mocks.execute).not.toHaveBeenCalled();expect(mocks.sql).not.toHaveBeenCalled();
 expect(response.json).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'approval_required'})}));
});
