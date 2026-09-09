/**
 * Unit tests for dunningService + dunningAdmin — PRD-06 Phase 5.
 *
 * Covers:
 *   1.  renderTemplate substitutes tokens, skips unknown tokens
 *   2.  renderTemplate returns null for missing invoice
 *   3.  renderTemplate throws when template doesn't belong to company
 *   4.  sendDunning rejects paid invoices
 *   5.  sendDunning rejects cancelled invoices
 *   6.  sendDunning rejects customer with no email
 *   7.  sendDunning inserts row + calls sendEmail + stamps email_status=sent
 *   8.  sendDunning stamps email_status=failed when sendEmail fails
 *   9.  listTemplates seeds the SA defaults on first (empty) call
 *   10. createTemplate rejects invalid days_overdue_max < days_overdue_min
 *   11. recordResponse returns updated=false for unknown token / already-responded
 *   12. recordResponse returns updated=true with sendId+companyId on success
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(sqlMock)),
  };
});

vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import {
  renderTemplate,
  sendDunning,
} from '@/modules/accounting/services/ar/dunningService';
import {
  listTemplates,
  createTemplate,
  recordResponse,
} from '@/modules/accounting/services/ar/dunningAdmin';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSendEmail = sendEmail as unknown as MockedFunction<typeof sendEmail>;

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEMPLATE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const INVOICE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SEND_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const TOKEN = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const EVIDENCE_DOC_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const PORTAL_TOKEN = 'a'.repeat(64);  // the 64-hex shape the portal route accepts

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    name: 'Polite reminder',
    tone: 'polite',
    escalation_order: 1,
    days_overdue_min: 7,
    days_overdue_max: 14,
    subject_template: 'Reminder: {{invoice_number}} — {{amount_outstanding}}',
    body_template:
      'Hi {{customer_name}}, {{invoice_number}} is {{days_overdue}} days overdue. ' +
      'Balance: {{amount_outstanding}}. Pay at {{portal_link}}. {{unknown_token}}',
    send_weekdays_only: true,
    active: true,
    created_at: '2026-04-23T00:00:00Z',
    updated_at: '2026-04-23T00:00:00Z',
    ...overrides,
  };
}

function invoiceCtxRow(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: INVOICE_ID,
    invoice_number: 'INV-100',
    invoice_date: '2026-04-01',
    due_date: '2026-04-10',
    total_amount: '1150.00',
    amount_paid: '0',
    status: 'sent',
    customer_name: 'Acme Corp',
    customer_email: 'ap@acme.co.za',
    company_name: 'Widgets Ltd',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('renderTemplate', () => {
  it('substitutes known tokens and leaves unknown tokens literal', async () => {
    mockSql.mockResolvedValueOnce([templateRow()]);
    mockSql.mockResolvedValueOnce([invoiceCtxRow()]);
    mockSql.mockResolvedValueOnce([{ portal_token: PORTAL_TOKEN }]);  // getOrMintInvoicePortalToken

    const rendered = await renderTemplate(
      COMPANY_ID, TEMPLATE_ID, INVOICE_ID, 'https://app.example.com',
    );
    expect(rendered).not.toBeNull();
    expect(rendered!.subject).toContain('INV-100');
    expect(rendered!.subject).toMatch(/R1[ \s]150,00/);
    expect(rendered!.body).toContain('Acme Corp');
    expect(rendered!.body).toContain(`https://app.example.com/portal/invoice/${PORTAL_TOKEN}`);
    expect(rendered!.body).toContain('{{unknown_token}}');  // left literal
    expect(rendered!.to_email).toBe('ap@acme.co.za');
  });

  it('returns null when invoice is missing', async () => {
    mockSql.mockResolvedValueOnce([templateRow()]);
    mockSql.mockResolvedValueOnce([]);  // no invoice
    const rendered = await renderTemplate(COMPANY_ID, TEMPLATE_ID, INVOICE_ID);
    expect(rendered).toBeNull();
  });

  it('throws when template not found for this company', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([invoiceCtxRow()]);
    await expect(
      renderTemplate(COMPANY_ID, TEMPLATE_ID, INVOICE_ID),
    ).rejects.toThrow(/Template .* not found/);
  });
});

describe('sendDunning', () => {
  it('rejects a fully-paid invoice', async () => {
    mockSql.mockResolvedValueOnce([invoiceCtxRow({
      total_amount: '1000.00', amount_paid: '1000.00',
    })]);
    await expect(
      sendDunning({ companyId: COMPANY_ID, templateId: TEMPLATE_ID, invoiceId: INVOICE_ID }),
    ).rejects.toThrow(/no outstanding balance/i);
  });

  it('rejects a cancelled invoice', async () => {
    mockSql.mockResolvedValueOnce([invoiceCtxRow({ status: 'cancelled' })]);
    await expect(
      sendDunning({ companyId: COMPANY_ID, templateId: TEMPLATE_ID, invoiceId: INVOICE_ID }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('rejects when customer has no email', async () => {
    mockSql.mockResolvedValueOnce([invoiceCtxRow({ customer_email: null })]);
    await expect(
      sendDunning({ companyId: COMPANY_ID, templateId: TEMPLATE_ID, invoiceId: INVOICE_ID }),
    ).rejects.toThrow(/no email address/i);
  });

  it('inserts dunning_sends row, calls sendEmail, stamps email_status=sent', async () => {
    mockSql.mockResolvedValueOnce([invoiceCtxRow()]);       // outstanding-balance guard
    mockSql.mockResolvedValueOnce([templateRow()]);         // renderTemplate → getTemplate
    mockSql.mockResolvedValueOnce([invoiceCtxRow()]);       // renderTemplate → loadInvoiceCtx
    mockSql.mockResolvedValueOnce([{ id: SEND_ID, message_token: TOKEN }]);   // INSERT dunning_sends
    mockSql.mockResolvedValueOnce([{ id: EVIDENCE_DOC_ID }]);                 // INSERT captured_documents
    mockSql.mockResolvedValueOnce([]);                      // UPDATE email_status + source_document_id
    mockSendEmail.mockResolvedValueOnce({ success: true, messageId: 'msg-1' });

    const result = await sendDunning({
      companyId: COMPANY_ID, templateId: TEMPLATE_ID, invoiceId: INVOICE_ID,
    });
    expect(result.sendId).toBe(SEND_ID);
    expect(result.messageToken).toBe(TOKEN);
    expect(result.emailStatus).toBe('sent');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0]![0].to).toBe('ap@acme.co.za');
    expect(mockSendEmail.mock.calls[0]![0].subject).toContain('INV-100');
  });

  it('stamps email_status=failed when sendEmail returns failure', async () => {
    mockSql.mockResolvedValueOnce([invoiceCtxRow()]);
    mockSql.mockResolvedValueOnce([templateRow()]);
    mockSql.mockResolvedValueOnce([invoiceCtxRow()]);
    mockSql.mockResolvedValueOnce([{ id: SEND_ID, message_token: TOKEN }]);
    mockSql.mockResolvedValueOnce([{ id: EVIDENCE_DOC_ID }]);                 // INSERT captured_documents
    mockSql.mockResolvedValueOnce([]);
    mockSendEmail.mockResolvedValueOnce({ success: false, error: 'SMTP down' });

    const result = await sendDunning({
      companyId: COMPANY_ID, templateId: TEMPLATE_ID, invoiceId: INVOICE_ID,
    });
    expect(result.emailStatus).toBe('failed');
    expect(result.emailError).toBe('SMTP down');
  });

  it('seals a captured_documents evidence row and stamps dunning_sends.source_document_id', async () => {
    mockSql.mockResolvedValueOnce([invoiceCtxRow()]);
    mockSql.mockResolvedValueOnce([templateRow()]);
    mockSql.mockResolvedValueOnce([invoiceCtxRow()]);
    mockSql.mockResolvedValueOnce([{ id: SEND_ID, message_token: TOKEN }]);
    mockSql.mockResolvedValueOnce([{ id: EVIDENCE_DOC_ID }]);
    mockSql.mockResolvedValueOnce([]);
    mockSendEmail.mockResolvedValueOnce({ success: true, messageId: 'msg-1' });

    await sendDunning({
      companyId: COMPANY_ID, templateId: TEMPLATE_ID, invoiceId: INVOICE_ID,
    });

    // Call 5 (0-indexed 4) is the captured_documents INSERT — assert the
    // tagged-template strings carry the document_type='dunning' literal.
    const captureCall = mockSql.mock.calls[4]!;
    const strings = (captureCall[0] as unknown as string[]).join(' ');
    expect(strings).toContain('captured_documents');
    expect(strings).toContain("'dunning'");

    // Call 6 is the dunning_sends UPDATE stamping source_document_id.
    const updateCall = mockSql.mock.calls[5]!;
    const updateStrings = (updateCall[0] as unknown as string[]).join(' ');
    expect(updateStrings).toContain('source_document_id');
    expect(updateCall).toContain(EVIDENCE_DOC_ID);
  });
});

describe('listTemplates + createTemplate', () => {
  it('seeds SA defaults when table is empty for the company', async () => {
    mockSql.mockResolvedValueOnce([]);                        // initial listTemplates — empty
    // seedDefaultTemplates: 4 INSERTs
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([templateRow(), templateRow({ tone: 'firm' })]);  // reload

    const templates = await listTemplates(COMPANY_ID);
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(mockSql).toHaveBeenCalledTimes(6);
  });

  it('createTemplate rejects days_overdue_max < days_overdue_min', async () => {
    await expect(
      createTemplate(COMPANY_ID, {
        name: 'Bad',
        tone: 'polite',
        escalation_order: 1,
        days_overdue_min: 30,
        days_overdue_max: 7,
        subject_template: 's', body_template: 'b',
      }),
    ).rejects.toThrow(/days_overdue_max/);
  });
});

describe('recordResponse', () => {
  it('returns updated=false when no matching unresponded send found', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await recordResponse(TOKEN, 'paid', null);
    expect(result.updated).toBe(false);
    expect(result.sendId).toBeNull();
  });

  it('returns updated=true with sendId and companyId on success', async () => {
    mockSql.mockResolvedValueOnce([{ id: SEND_ID, company_id: COMPANY_ID }]);
    const result = await recordResponse(TOKEN, 'disputed', 'Customer says wrong amount');
    expect(result.updated).toBe(true);
    expect(result.sendId).toBe(SEND_ID);
    expect(result.companyId).toBe(COMPANY_ID);
  });
});
