import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  readPayment: vi.fn(), readInvoice: vi.fn(), create: vi.fn(), post: vi.fn(), reverse: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ id: 'entity', status: 'approved' }]),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({ getSupplierPaymentById: mocks.readPayment }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({ getSupplierInvoiceById: mocks.readInvoice }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceLock', () => ({ lockSupplierInvoiceForUpdate: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ createJournalEntry: mocks.create, postJournalEntry: mocks.post, reverseJournalEntry: mocks.reverse }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn(async () => ({ id: 'account' })) }));
import { approveSupplierPayment, processSupplierPayment, voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { approveSupplierInvoice, postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
beforeEach(() => {
  vi.clearAllMocks(); mocks.create.mockResolvedValue({ id: 'journal' });
  mocks.readPayment.mockResolvedValue({ id: 'entity', status: 'approved', totalAmount: 100, allocations: [], paymentDate: '2026-09-09' });
  mocks.readInvoice.mockResolvedValue({ id: 'entity', status: 'draft', subtotal: 100, taxAmount: 0, totalAmount: 100, items: [] });
});
it.each([
  ['payment process', processSupplierPayment], ['invoice approve', approveSupplierInvoice], ['invoice post', postSupplierInvoiceToGL],
] as const)('%s refuses an unauthenticated shared-service call before financial effects', async (_name, fn) => {
  await expect(fn('company', 'entity', 'person')).rejects.toThrow(/control transaction/i);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});
it('payment void refuses an unauthenticated caller before reversal', async () => {
  mocks.readPayment.mockResolvedValue({ id: 'entity', status: 'processed', allocations: [] });
  await expect(voidSupplierPayment('company', 'entity', 'person')).rejects.toThrow(/control transaction/i);
  expect(mocks.reverse).not.toHaveBeenCalled();
});

it('payment status approval also requires the active actor before mutation', async () => {
  mocks.readPayment.mockResolvedValue({ id: 'entity', status: 'draft' });
  await expect(approveSupplierPayment('company', 'entity', 'person')).rejects.toThrow(/control transaction/i);
  expect(mocks.readPayment).not.toHaveBeenCalled();
});
