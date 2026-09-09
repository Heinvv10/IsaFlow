import {beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({assert:vi.fn(),sql:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:mock.assert}));
import {lockArInvoiceSources,lockArPaymentSources} from '@/modules/accounting/services/controls/arSourceMaterial';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const ctx={principal:{companyId:'tenant'},sql:mock.sql} as unknown as ControlTx;
beforeEach(()=>{vi.clearAllMocks();mock.assert.mockImplementation(()=>{});});
it('rejects unissued request contexts before querying any source',async()=>{mock.assert.mockImplementation(()=>{throw new Error('context unavailable');});await expect(lockArInvoiceSources(ctx,'id')).rejects.toThrow('context unavailable');expect(mock.sql).not.toHaveBeenCalled();});
it('refuses invoices with a missing owned customer instead of accepting their tenantless link',async()=>{mock.sql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);await expect(lockArInvoiceSources(ctx,'id')).rejects.toThrow('not found');});
it('refuses allocation rows omitted by owned same-customer joins',async()=>{mock.sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{id:'payment',client_id:'customer'}]).mockResolvedValueOnce([]).mockResolvedValueOnce([{count:1}]);await expect(lockArPaymentSources(ctx,'payment')).rejects.toThrow('allocation material is incomplete');});
it('retains complete owned invoice headers for allocation source versions',async()=>{
 const invoice={id:'invoice',invoice_date:'2026-09-01',description:'Authoritative header'};
 mock.sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{id:'payment',client_id:'customer'}]).mockResolvedValueOnce([{invoice_id:'invoice'}]).mockResolvedValueOnce([{count:1}]).mockResolvedValueOnce([invoice]).mockResolvedValueOnce([]);
 expect(await lockArPaymentSources(ctx,'payment')).toMatchObject({invoices:[invoice]});
});
