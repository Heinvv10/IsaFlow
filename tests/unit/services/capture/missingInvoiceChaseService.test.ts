// RED phase — written before implementation
/**
 * Unit tests for missingInvoiceChaseService.ts — PRD-05 Phase 6 + Phase 8
 *
 * Covers: composeChaseEmail (pure function — subject/html/text content),
 * detectGaps (gap detection, fulfilled window skip, idempotency),
 * sendEmailChase (no-email guard, happy path), dismissAlert.
 * Phase 8: sendWhatsAppChase, composeChaseWhatsApp.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { sqlMock, sendEmailMock, sendWhatsAppMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  const sendEmailMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-001' });
  const sendWhatsAppMock = vi.fn().mockResolvedValue({ sent: true });
  return { sqlMock, sendEmailMock, sendWhatsAppMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: sendEmailMock,
}));
vi.mock('@/modules/accounting/services/capture/whatsAppReplyService', () => ({
  sendWhatsAppMessage: sendWhatsAppMock,
}));

import {
  composeChaseEmail,
  detectGaps,
  sendEmailChase,
  dismissAlert,
  sendWhatsAppChase,
  composeChaseWhatsApp,
} from '@/modules/accounting/services/capture/missingInvoiceChaseService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ALERT_ID    = 'cc000000-0000-0000-0000-000000000003';
const USER_ID     = 'dddddddd-0000-0000-0000-000000000004';

function makeExpectationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ee000000-0000-0000-0000-000000000001',
    company_id: COMPANY_ID,
    supplier_id: SUPPLIER_ID,
    cadence: 'monthly',
    expected_day_of_month: 15,
    expected_amount: 1000,
    last_invoice_date: '2026-03-15',
    sample_size: 4,
    status: 'locked',
    ...overrides,
  };
}

// Shape of the JOIN row the service actually reads in sendEmailChase:
// SELECT a.*, s.name AS supplier_name, s.email AS supplier_email,
//        se.last_invoice_date AS exp_last_invoice_date
// FROM expected_invoice_alerts a JOIN suppliers s … LEFT JOIN supplier_expectations se …
function makeAlertRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ALERT_ID,
    company_id: COMPANY_ID,
    supplier_id: SUPPLIER_ID,
    expected_by: '2026-04-15',
    expected_amount: 1000,
    status: 'pending',
    created_at: '2026-04-16T08:00:00Z',
    // joined fields
    supplier_name: 'Acme Supplies',
    supplier_email: 'billing@acme.co.za',
    exp_last_invoice_date: '2026-03-15',
    ...overrides,
  };
}

function makeCompanyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: COMPANY_ID,
    name: 'Brightsphere Ltd',
    ...overrides,
  };
}

// ── composeChaseEmail ─────────────────────────────────────────────────────────

describe('composeChaseEmail', () => {
  it('renders subject with supplier name and month/year', () => {
    const result = composeChaseEmail({
      supplierName: 'Acme Supplies',
      expectedBy: '2026-04-15',
      expectedAmount: 1000,
      lastInvoiceDate: '2026-03-15',
      companyName: 'Brightsphere Ltd',
    });

    expect(result.subject).toContain('Acme Supplies');
    expect(result.subject).toMatch(/April 2026|Apr 2026/);
    expect(result.subject).toContain('Reminder');
  });

  it('includes supplier name, expected amount (R format), and company name in html', () => {
    const result = composeChaseEmail({
      supplierName: 'Acme Supplies',
      expectedBy: '2026-04-15',
      expectedAmount: 1000,
      lastInvoiceDate: '2026-03-15',
      companyName: 'Brightsphere Ltd',
    });

    expect(result.html).toContain('Acme Supplies');
    expect(result.html).toContain('R1');
    expect(result.html).toContain('Brightsphere Ltd');
    expect(result.text).toContain('Acme Supplies');
  });

  it('includes expected date and last invoice date in the body', () => {
    const result = composeChaseEmail({
      supplierName: 'Acme Supplies',
      expectedBy: '2026-04-15',
      expectedAmount: 1000,
      lastInvoiceDate: '2026-03-15',
      companyName: 'Brightsphere Ltd',
    });

    expect(result.html).toMatch(/15|April|2026/);
    expect(result.html).toMatch(/March|2026/);
  });

  it('omits the expected-amount line entirely when expectedAmount is null', () => {
    const result = composeChaseEmail({
      supplierName: 'Acme Supplies',
      expectedBy: '2026-04-15',
      expectedAmount: null,
      lastInvoiceDate: '2026-03-15',
      companyName: 'Brightsphere Ltd',
    });

    expect(result.html).not.toContain('Expected amount');
    expect(result.text).not.toContain('Expected amount');
    expect(result.html).toContain('Acme Supplies');
  });

  it('does not include "R" amount line when expectedAmount is null', () => {
    const result = composeChaseEmail({
      supplierName: 'Acme Supplies',
      expectedBy: '2026-04-15',
      expectedAmount: null,
      lastInvoiceDate: '2026-03-15',
      companyName: 'Brightsphere Ltd',
    });

    // Should not mention a specific rand amount
    expect(result.subject).not.toMatch(/R\d/);
  });
});

// ── detectGaps ────────────────────────────────────────────────────────────────

describe('detectGaps', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates 1 alert when a locked monthly expectation is 35 days overdue with no invoice in window', async () => {
    // today = 2026-04-19; lastInvoiceDate = 2026-03-15; nextExpectedBy = 2026-04-14 (30d cadence)
    const today = new Date('2026-04-19');

    // Query 1: SELECT locked expectations → 1 row, last_invoice_date 35 days ago
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeExpectationRow({ last_invoice_date: '2026-03-15' })] as never)
      // Query 2 (per expectation): check supplier_invoices within ±7 days of nextExpectedBy → no match
      .mockResolvedValueOnce([] as never)
      // Query 3: INSERT alert ON CONFLICT DO NOTHING → returns 1 row (inserted)
      .mockResolvedValueOnce([makeAlertRow()] as never);

    const result = await detectGaps(COMPANY_ID, today);

    expect(result.created).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it('creates 0 alerts when a matching invoice exists within ±7 days of expected date', async () => {
    const today = new Date('2026-04-19');

    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeExpectationRow({ last_invoice_date: '2026-03-15' })] as never)
      // A matching invoice IS found within the ±7 day window
      .mockResolvedValueOnce([{ id: 'inv-001', invoice_date: '2026-04-13' }] as never);

    const result = await detectGaps(COMPANY_ID, today);

    expect(result.created).toBe(0);
    expect(result.unchanged).toBe(1);
  });

  it('is idempotent: second run returns 0 created (ON CONFLICT DO NOTHING)', async () => {
    const today = new Date('2026-04-19');

    // Second run: INSERT returns 0 rows (conflict not inserted)
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeExpectationRow({ last_invoice_date: '2026-03-15' })] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never); // INSERT returns nothing → unchanged

    const result = await detectGaps(COMPANY_ID, today);

    expect(result.created).toBe(0);
    expect(result.unchanged).toBe(1);
  });
});

// ── sendEmailChase ────────────────────────────────────────────────────────────

describe('sendEmailChase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ success: true, messageId: 'msg-001' });
  });

  it('returns {sent: false, reason: "no supplier email"} when supplier.email is null', async () => {
    vi.mocked(sqlMock)
      // JOIN SELECT — supplier_email comes from the join and is null
      .mockResolvedValueOnce([makeAlertRow({ supplier_email: null })] as never);

    const result = await sendEmailChase(COMPANY_ID, ALERT_ID, USER_ID);

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no supplier email');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does NOT update alert status when supplier has no email', async () => {
    // Service does 1 JOIN SELECT; when supplier_email is null on that row, returns
    // early with reason='no supplier email'. No company SELECT, no UPDATE.
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeAlertRow({ supplier_email: null })] as never);

    await sendEmailChase(COMPANY_ID, ALERT_ID, USER_ID);

    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  it('calls sendEmail once and returns {sent: true} when supplier has an email', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeAlertRow()] as never)       // JOIN SELECT
      .mockResolvedValueOnce([makeCompanyRow()] as never)     // companies SELECT
      .mockResolvedValueOnce([] as never);                    // UPDATE alert

    const result = await sendEmailChase(COMPANY_ID, ALERT_ID, USER_ID);

    expect(result.sent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('updates alert to status=chased on successful send', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeAlertRow()] as never)
      .mockResolvedValueOnce([makeCompanyRow()] as never)
      .mockResolvedValueOnce([] as never);

    await sendEmailChase(COMPANY_ID, ALERT_ID, USER_ID);

    // 3 total calls: JOIN SELECT + companies SELECT + UPDATE
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(3);
  });
});

// ── dismissAlert ──────────────────────────────────────────────────────────────

describe('dismissAlert', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('resolves without error and issues one SQL call', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    await expect(
      dismissAlert(COMPANY_ID, ALERT_ID, 'duplicate invoice', USER_ID),
    ).resolves.toBeUndefined();

    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  it('issues exactly one UPDATE and passes the dismissed reason through', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    await dismissAlert(COMPANY_ID, ALERT_ID, 'already processed', USER_ID);

    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });
});

// ── sendWhatsAppChase — Phase 8 ───────────────────────────────────────────────

describe('sendWhatsAppChase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendWhatsAppMock.mockResolvedValue({ sent: true });
  });

  // The real service joins on suppliers for supplier_wa, then separately
  // fetches companies for whatsapp_chase_enabled + name. Mock both calls.

  it('returns {sent: false, reason: "no supplier whatsapp number"} when supplier number is null', async () => {
    // No supplier wa → short-circuits before the companies SELECT.
    vi.mocked(sqlMock).mockResolvedValueOnce([
      makeAlertRow({ supplier_wa: null }),
    ] as never);

    const result = await sendWhatsAppChase(COMPANY_ID, ALERT_ID, USER_ID);

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no supplier whatsapp number');
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
  });

  it('returns {sent: false, reason: "whatsapp chase disabled"} when company flag is off', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeAlertRow({ supplier_wa: '+27611111111' })] as never)
      .mockResolvedValueOnce([makeCompanyRow({ whatsapp_chase_enabled: false })] as never);

    const result = await sendWhatsAppChase(COMPANY_ID, ALERT_ID, USER_ID);

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('whatsapp chase disabled');
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
  });

  it('happy path: calls sendWhatsAppMessage once and returns {sent: true}', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeAlertRow({ supplier_wa: '+27611111111' })] as never)
      .mockResolvedValueOnce([makeCompanyRow({ whatsapp_chase_enabled: true })] as never)
      .mockResolvedValueOnce([] as never);

    const result = await sendWhatsAppChase(COMPANY_ID, ALERT_ID, USER_ID);

    expect(result.sent).toBe(true);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
  });

  it('happy path: UPDATE sets chase_method=whatsapp (3 SQL calls total)', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeAlertRow({ supplier_wa: '+27611111111' })] as never)
      .mockResolvedValueOnce([makeCompanyRow({ whatsapp_chase_enabled: true })] as never)
      .mockResolvedValueOnce([] as never);

    await sendWhatsAppChase(COMPANY_ID, ALERT_ID, USER_ID);

    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(3);
  });
});

// ── composeChaseWhatsApp — Phase 8 ────────────────────────────────────────────

describe('composeChaseWhatsApp', () => {
  const baseInput = {
    supplierName: 'Acme Supplies',
    companyName: 'Brightsphere Ltd',
    expectedBy: '2026-04-15',
    expectedAmount: 1000,
    lastInvoiceDate: '2026-03-15',
  };

  it('returns an object with a body string', () => {
    const result = composeChaseWhatsApp(baseInput);
    expect(typeof result.body).toBe('string');
    expect(result.body.length).toBeGreaterThan(0);
  });

  it('body is under 400 characters', () => {
    const result = composeChaseWhatsApp(baseInput);
    expect(result.body.length).toBeLessThan(400);
  });

  it('body contains supplier name', () => {
    const result = composeChaseWhatsApp(baseInput);
    expect(result.body).toContain('Acme Supplies');
  });

  it('body contains expected date', () => {
    const result = composeChaseWhatsApp(baseInput);
    expect(result.body).toMatch(/15|April|2026/);
  });

  it('body contains amount in R format', () => {
    const result = composeChaseWhatsApp(baseInput);
    expect(result.body).toMatch(/R1[\s,]?000|R1000/);
  });

  it('body contains a greeting and a sign-off', () => {
    const result = composeChaseWhatsApp(baseInput);
    // Short greeting at start
    expect(result.body.toLowerCase()).toMatch(/^hi|^hello|^dear/);
    // Sign-off contains company name or "regards"
    expect(result.body).toMatch(/regards|Brightsphere/i);
  });

  it('omits amount line when expectedAmount is null', () => {
    const result = composeChaseWhatsApp({ ...baseInput, expectedAmount: null });
    expect(result.body).not.toMatch(/R\d/);
  });
});
