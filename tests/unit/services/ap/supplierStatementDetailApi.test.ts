import { beforeEach, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
import { sql } from '@/lib/neon';
import handler from '../../../../../pages/api/accounting/supplier-statement-detail';
const supplierId = '8feca858-a00a-41ff-b71d-2b77d0dcfaa5';
const companyId = '11111111-1111-4111-9111-111111111111';
function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
beforeEach(() => vi.resetAllMocks());
it('loads UUID supplier history with company scoping on every query', async () => {
  vi.mocked(sql).mockImplementation(async (strings, ...values) => {
    expect(values).toContain(supplierId);
    expect(values).toContain(companyId);
    expect(strings.join('')).toContain('company_id');
    const query = strings.join('');
    if (query.includes('SELECT id, name')) return [{ id: supplierId, name: 'Supplier', email: null, phone: null }];
    if (query.includes('AS total_invoiced')) return [{ total_invoiced: 100, total_paid: 0, total_returns: 0 }];
    if (query.includes('FROM supplier_invoices')) return [{ id: supplierId, reference: 'INV-1', date: new Date('2026-09-01'), amount: 100, description: '' }];
    return [];
  });
  const res = response();
  await handler({ method: 'GET', query: { supplier_id: supplierId }, companyId } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ transactions: [expect.objectContaining({ reference: 'INV-1', balance: 100 })] }) }));
});
it.each([undefined, '123', 'invalid', [supplierId, supplierId]])('rejects malformed supplier ID %s without querying', async (id) => {
  const res = response();
  await handler({ method: 'GET', query: { supplier_id: id }, companyId } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(sql).not.toHaveBeenCalled();
});
it('applies the selected cutoff to all detail and aggregate sources', async () => {
 vi.mocked(sql).mockImplementation(async (strings,...values) => {
  const query=strings.join('');
  if(query.includes('SELECT id, name')) return [{id:supplierId,name:'Supplier'}];
  expect(values).toContain('2026-08-31');
  if(query.includes('AS total_invoiced')) return [{total_invoiced:0,total_paid:0,total_returns:0}];
  return [];
 });
 const res=response();
 await handler({method:'GET',query:{supplier_id:supplierId,as_at_date:'2026-08-31'},companyId} as unknown as NextApiRequest,res as unknown as NextApiResponse);
 expect(res.status).toHaveBeenCalledWith(200);
});
it.each(['2026-02-31',['2026-08-31']])('rejects invalid cutoff %s before querying',async (date)=>{
 const res=response();
 await handler({method:'GET',query:{supplier_id:supplierId,as_at_date:date},companyId} as unknown as NextApiRequest,res as unknown as NextApiResponse);
 expect(res.status).toHaveBeenCalledWith(400);
 expect(sql).not.toHaveBeenCalled();
});
