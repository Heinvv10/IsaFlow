/**
 * PR S round seventeen: the invoice email attaches the SEALED PDF when the invoice has one (the approved document, as
 * approved: the customer and bank details the approver compared), as the PDF routes serve it, and renders one now only
 * for an invoice never sealed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(), sealed: vi.fn(), download: vi.fn(), generate: vi.fn(), send: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/invoicePdfService', () => ({ generateInvoicePdf: m.generate }));
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({ getSealedInvoicePdf: m.sealed }));
vi.mock('@/lib/supabaseStorage', () => ({ downloadCapturedDocument: m.download }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: m.send }));
vi.mock('@/modules/accounting/services/core/webhookService', () => ({ fireWebhook: vi.fn() }));

import { sendInvoiceEmail } from '@/modules/accounting/services/core/emailNotificationService';

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockImplementation(async (strings: TemplateStringsArray) => (strings.join('?').includes('FROM customer_invoices ci')
    ? [{ invoice_number: 'INV-1', invoice_date: '2026-09-01', due_date: '2026-10-01', total_amount: '115.00', amount_paid: '0', client_name: 'Acme' }]
    : strings.join('?').includes('FROM companies') ? [{ name: 'Issuer', invoice_email_signature: null }] : []));
  m.send.mockResolvedValue({ success: false, error: 'not sent in tests' });
  m.download.mockResolvedValue(Buffer.from('%PDF sealed'));
  m.generate.mockResolvedValue(Buffer.from('%PDF rendered now'));
});
const attached = () => String((m.send.mock.calls[0]![0] as { attachments: { content: Buffer }[] }).attachments[0]!.content);

describe('the invoice email attachment', () => {
  it('is the sealed PDF when the invoice has one: nothing is rendered from today\'s records', async () => {
    m.sealed.mockResolvedValue({ bucket: 'customer-invoices', path: 'co/doc.pdf', sha256: 'x', renderedAt: new Date() });
    await sendInvoiceEmail('co', 'inv', 'billing@client.example');
    expect(m.download).toHaveBeenCalledWith('customer-invoices', 'co/doc.pdf', 'co');
    expect(m.generate).not.toHaveBeenCalled();
    expect(attached()).toBe('%PDF sealed');
  });

  it('is rendered now for an invoice never sealed', async () => {
    m.sealed.mockResolvedValue(null);
    await sendInvoiceEmail('co', 'inv', 'billing@client.example');
    expect(m.generate).toHaveBeenCalledWith('co', 'inv');
    expect(attached()).toBe('%PDF rendered now');
  });
});
