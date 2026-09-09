import {beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({sql:vi.fn(),context:vi.fn()}));
vi.mock('@/lib/neon',()=>({sql:mock.sql,withSavepoint:async(_name:string,fn:()=>Promise<unknown>)=>fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mock.context,assertControlTx:vi.fn()}));
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:vi.fn()}));
import {cancelCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import {postCustomerInvoiceToGL} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
beforeEach(()=>{vi.clearAllMocks();mock.context.mockImplementation(()=>{throw new Error('Request context unavailable');});mock.sql.mockRejectedValue(new Error('Unfenced source query'));});
it('approval ingress refuses an absent active principal before its status mutation',async()=>{await expect(approveCustomerInvoice('company','invoice','person')).rejects.toThrow('Request context unavailable');expect(mock.sql).not.toHaveBeenCalled();});
it('direct GL ingress refuses an absent active principal before reading or writing financial sources',async()=>{await expect(postCustomerInvoiceToGL('company','invoice','person')).rejects.toThrow('Request context unavailable');expect(mock.sql).not.toHaveBeenCalled();});
it('a historical-import boolean cannot grant direct posting authority',async()=>{await expect(postCustomerInvoiceToGL('company','invoice','person',{historicalImport:true})).rejects.toThrow('Historical import requires');expect(mock.sql).not.toHaveBeenCalled();});

it('cancellation requires current context before inspecting or reversing its source',async()=>{await expect(cancelCustomerInvoice('company','invoice','person')).rejects.toThrow('Request context unavailable');expect(mock.sql).not.toHaveBeenCalled();});
it('payment confirmation requires current context before querying financial sources',async()=>{const {confirmCustomerPayment}=await import('@/modules/accounting/services/ar/customerPaymentAllocationService');await expect(confirmCustomerPayment('company','payment','person')).rejects.toThrow('Request context unavailable');expect(mock.sql).not.toHaveBeenCalled();});
it('payment cancellation requires current context before querying financial sources',async()=>{const {cancelCustomerPayment}=await import('@/modules/accounting/services/ar/customerPaymentAllocationService');await expect(cancelCustomerPayment('company','payment','person')).rejects.toThrow('Request context unavailable');expect(mock.sql).not.toHaveBeenCalled();});

it('credit approval requires current context before touching a note',async()=>{const {approveCreditNote}=await import('@/modules/accounting/services/ar/creditNoteApproveService');await expect(approveCreditNote('company','credit','person')).rejects.toThrow('Request context unavailable');expect(mock.sql).not.toHaveBeenCalled();});
it('credit cancellation requires current context before touching a note',async()=>{const {cancelCreditNote}=await import('@/modules/accounting/services/ar/creditNoteCancelService');await expect(cancelCreditNote('company','credit','person')).rejects.toThrow('Request context unavailable');expect(mock.sql).not.toHaveBeenCalled();});
it('credit application requires current context before preparing its immutable intent',async()=>{const {applyCreditNoteToInvoice}=await import('@/modules/accounting/services/ar/creditNoteCancelService');await expect(applyCreditNoteToInvoice('company','credit','invoice','person')).rejects.toThrow('Request context unavailable');expect(mock.sql).not.toHaveBeenCalled();});

it('recurring execution requires current context before creating a draft or consuming its schedule',async()=>{const {generateInvoiceFromRecurring}=await import('@/modules/accounting/services/ar/recurringInvoiceService');await expect(generateInvoiceFromRecurring('company','template','person')).rejects.toThrow('Request context unavailable');expect(mock.sql).not.toHaveBeenCalled();});
