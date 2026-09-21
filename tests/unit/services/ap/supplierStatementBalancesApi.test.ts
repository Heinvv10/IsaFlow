import { beforeEach, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
vi.mock('@/lib/auth',()=>({withAuth:(h:unknown)=>h}));
vi.mock('@/lib/api-error-handler',()=>({withErrorHandler:(h:unknown)=>h}));
vi.mock('@/modules/accounting/services/ap/supplierStatementBalancesService',()=>({getSupplierStatementBalances:vi.fn()}));
import {getSupplierStatementBalances} from '@/modules/accounting/services/ap/supplierStatementBalancesService';
import handler from '../../../../../pages/api/accounting/supplier-statement-balances';
const companyId='11111111-1111-4111-9111-111111111111';
function response() { const res={status:vi.fn(),json:vi.fn()};res.status.mockReturnValue(res);return res; }
beforeEach(()=>vi.resetAllMocks());
it('uses authenticated company and selected date for the statement list',async()=>{
 vi.mocked(getSupplierStatementBalances).mockResolvedValue([]);
 const res=response();
 await handler({method:'GET',query:{as_at_date:'2026-08-31',company_id:'other-tenant'},companyId} as unknown as NextApiRequest,res as unknown as NextApiResponse);
 expect(getSupplierStatementBalances).toHaveBeenCalledWith(companyId,'2026-08-31');
 expect(res.status).toHaveBeenCalledWith(200);
});
it.each(['2026-02-31',['2026-08-31'],'invalid'])('rejects invalid date %s without loading balances',async(date)=>{
 const res=response();
 await handler({method:'GET',query:{as_at_date:date},companyId} as unknown as NextApiRequest,res as unknown as NextApiResponse);
 expect(res.status).toHaveBeenCalledWith(400);
 expect(getSupplierStatementBalances).not.toHaveBeenCalled();
});
