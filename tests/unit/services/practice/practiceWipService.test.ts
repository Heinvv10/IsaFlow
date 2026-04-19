import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, markEntriesBilledMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  const markEntriesBilledMock = vi.fn();
  return { sqlMock, markEntriesBilledMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/practice/practiceTimeEntryWorkflow', () => ({
  markEntriesBilled: markEntriesBilledMock,
}));

import {
  getWipByClient,
  generateWipInvoice,
} from '@/modules/accounting/services/practice/practiceWipService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT = 'cccccccc-0000-0000-0000-000000000003';
const LINK_CUSTOMER = 'dddddddd-0000-0000-0000-000000000004';
const ENTRY_A = 'eeeeeeee-0000-0000-0000-000000000005';
const ENTRY_B = 'ffffffff-0000-0000-0000-000000000006';
const INVOICE_ID = '11111111-0000-0000-0000-000000000007';

beforeEach(() => vi.clearAllMocks());

describe('getWipByClient', () => {
  it('groups approved unbilled entries by practice_client_id', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        practice_client_id: CLIENT,
        legal_name: 'Acme (Pty) Ltd',
        link_customer_id: LINK_CUSTOMER,
        total_hours: 5,
        total_value: 4250,
        oldest_approved_date: new Date('2026-04-10'),
      },
    ]);
    sqlMock.mockResolvedValueOnce([
      {
        id: ENTRY_A,
        company_id: COMPANY,
        user_id: USER,
        entry_date: '2026-04-10',
        hours: 2,
        practice_client_id: CLIENT,
        job_category_id: 'cat-1',
        work_item_id: 'wi-1',
        task_description: 'Bookkeeping',
        notes: null,
        billable: true,
        applied_rate: 850,
        line_total: 1700,
        origin: 'manual',
        status: 'approved',
        approved_by: USER,
        approved_at: new Date('2026-04-11'),
        billed_at: null,
        invoice_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    const result = await getWipByClient(COMPANY);
    expect(result).toHaveLength(1);
    expect(result[0]!.practiceClientId).toBe(CLIENT);
    expect(result[0]!.totalValue).toBe(4250);
    expect(result[0]!.entries).toHaveLength(1);
  });
});

describe('generateWipInvoice', () => {
  const baseInput = {
    practiceClientId: CLIENT,
    timeEntryIds: [ENTRY_A, ENTRY_B],
  };

  it('rejects client with no link_customer_id', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active', link_customer_id: null }]);
    await expect(generateWipInvoice(COMPANY, USER, baseInput))
      .rejects.toThrow(/link_customer_id/);
  });

  it('rejects when no eligible entries found', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active', link_customer_id: LINK_CUSTOMER }]);
    sqlMock.mockResolvedValueOnce([]);
    await expect(generateWipInvoice(COMPANY, USER, baseInput))
      .rejects.toThrow(/no eligible approved/);
  });

  it('creates invoice with detailed line items and marks entries billed', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active', link_customer_id: LINK_CUSTOMER }]);
    sqlMock.mockResolvedValueOnce([
      {
        id: ENTRY_A, hours: 2, applied_rate: 850, line_total: 1700,
        entry_date: '2026-04-10', task_description: 'Bookkeeping',
        work_item_name: 'Monthly bookkeeping', job_category_name: 'Accounting',
      },
      {
        id: ENTRY_B, hours: 3, applied_rate: 850, line_total: 2550,
        entry_date: '2026-04-11', task_description: 'Reconciliation',
        work_item_name: 'Bank recon', job_category_name: 'Accounting',
      },
    ]);
    sqlMock.mockResolvedValueOnce([{ max_num: 0 }]);     // max invoice number
    sqlMock.mockResolvedValueOnce([{ id: INVOICE_ID }]); // INSERT invoice
    sqlMock.mockResolvedValueOnce([]);                   // INSERT line item A
    sqlMock.mockResolvedValueOnce([]);                   // INSERT line item B
    markEntriesBilledMock.mockResolvedValueOnce(2);

    const result = await generateWipInvoice(COMPANY, USER, baseInput);

    expect(result.lineCount).toBe(2);
    expect(result.subtotal).toBe(4250);
    expect(result.taxAmount).toBe(637.5);
    expect(result.totalAmount).toBe(4887.5);
    expect(result.invoiceId).toBe(INVOICE_ID);
    expect(result.invoiceNumber).toMatch(/^INV-\d{5}$/);
    expect(markEntriesBilledMock).toHaveBeenCalledWith(COMPANY, [ENTRY_A, ENTRY_B], INVOICE_ID);
  });

  it('groupBy=by_work_item collapses entries per work item', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active', link_customer_id: LINK_CUSTOMER }]);
    sqlMock.mockResolvedValueOnce([
      {
        id: ENTRY_A, hours: 2, applied_rate: 850, line_total: 1700,
        entry_date: '2026-04-10', work_item_id: 'wi-1',
        work_item_name: 'Monthly bookkeeping',
        task_description: 'Bookkeeping',
        job_category_id: 'cat-1', job_category_name: 'Accounting',
      },
      {
        id: ENTRY_B, hours: 1, applied_rate: 850, line_total: 850,
        entry_date: '2026-04-11', work_item_id: 'wi-1',
        work_item_name: 'Monthly bookkeeping',
        task_description: 'More bookkeeping',
        job_category_id: 'cat-1', job_category_name: 'Accounting',
      },
    ]);
    sqlMock.mockResolvedValueOnce([{ max_num: 0 }]);
    sqlMock.mockResolvedValueOnce([{ id: INVOICE_ID }]);
    sqlMock.mockResolvedValueOnce([]); // ONE line item (grouped)
    markEntriesBilledMock.mockResolvedValueOnce(2);

    const result = await generateWipInvoice(COMPANY, USER, {
      ...baseInput,
      groupBy: 'by_work_item',
    });

    // Only ONE line item insert expected (2 entries → 1 grouped line)
    const insertLineItemCalls = sqlMock.mock.calls.filter((c) => {
      const strings = c[0] as TemplateStringsArray;
      return strings.some((s) => s.includes('INSERT INTO customer_invoice_items'));
    });
    expect(insertLineItemCalls).toHaveLength(1);
    expect(result.lineCount).toBe(1);
  });

  it('groupBy=by_category collapses entries per category', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CLIENT, status: 'active', link_customer_id: LINK_CUSTOMER }]);
    sqlMock.mockResolvedValueOnce([
      {
        id: ENTRY_A, hours: 2, applied_rate: 850, line_total: 1700,
        entry_date: '2026-04-10', work_item_id: 'wi-1', job_category_id: 'cat-1',
        work_item_name: 'Monthly bookkeeping', job_category_name: 'Accounting',
      },
      {
        id: ENTRY_B, hours: 3, applied_rate: 850, line_total: 2550,
        entry_date: '2026-04-11', work_item_id: 'wi-2', job_category_id: 'cat-1',
        work_item_name: 'Bank recon', job_category_name: 'Accounting',
      },
    ]);
    sqlMock.mockResolvedValueOnce([{ max_num: 0 }]);
    sqlMock.mockResolvedValueOnce([{ id: INVOICE_ID }]);
    sqlMock.mockResolvedValueOnce([]); // single grouped line
    markEntriesBilledMock.mockResolvedValueOnce(2);

    const result = await generateWipInvoice(COMPANY, USER, {
      ...baseInput,
      groupBy: 'by_category',
    });

    const insertLineItemCalls = sqlMock.mock.calls.filter((c) => {
      const strings = c[0] as TemplateStringsArray;
      return strings.some((s) => s.includes('INSERT INTO customer_invoice_items'));
    });
    expect(insertLineItemCalls).toHaveLength(1);
    expect(result.lineCount).toBe(1);
  });
});
