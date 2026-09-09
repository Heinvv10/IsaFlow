import { expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({approve:vi.fn(async()=>({id:'invoice'})),create:vi.fn(async()=>({id:'invoice'})),sql:vi.fn(async(strings:TemplateStringsArray)=>strings.join('?').includes('FROM suppliers')?[{id:'supplier'}]:[])}));
vi.mock('@/lib/neon',()=>({sql:mocks.sql,withSavepoint:vi.fn()}));
vi.mock('@/lib/logger',()=>({log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService',()=>({createSupplierInvoice:mocks.create,approveSupplierInvoice:mocks.approve}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver',()=>({getSystemAccount:vi.fn(async()=>({id:'account'}))}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService',()=>({createJournalEntry:vi.fn(async()=>({id:'journal'}))}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService',()=>({assertNoInactiveAccountLines:vi.fn()}));
import {commitAPInvoice} from '@/modules/admin/services/sageMigrationCommitService';
it('routes imported AP posting through the shared invoice control without a raw posted update',async()=>{
 await commitAPInvoice('company','person',{supplierName:'Synthetic',invoiceNumber:'SYNTHETIC',invoiceDate:'2026-02-28',subtotal:100,taxAmount:15,totalAmount:115});
 expect(mocks.approve).toHaveBeenCalledWith('company','invoice','person');
 expect(mocks.sql.mock.calls.map(call=>call[0].join('?')).some(query=>query.includes("status = 'posted'"))).toBe(false);
});
