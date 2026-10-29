/**
 * R-075 census — service-level sites that used to fire-and-forget work whose
 * later queries outlived the request. Inside a request transaction each must
 * now QUEUE that work (nothing starts until the owner drains after COMMIT), and
 * outside one it must still start at once, as before. Run inside the real
 * AsyncLocalStorage with a context that carries an after-commit queue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const m = vi.hoisted(() => ({
  recalculateNudge: vi.fn(async () => 'none'),
  extractFromImage: vi.fn(async () => ({ confidence: 0 })),
  fireWebhook: vi.fn(async () => undefined),
  runBudgetRolls: vi.fn(async () => undefined),
  sql: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => ({ planCode: 'payg' })) }));
vi.mock('@/modules/billing/services/flowWalletService', () => ({
  deductFlows: vi.fn(async () => ({ balanceAfter: 9 })), refundFlows: vi.fn(), triggerAutoTopup: vi.fn(),
  recalculateNudge: m.recalculateNudge, InsufficientFlowsError: class extends Error {},
}));
vi.mock('@/services/vfStorageAdapter', () => ({
  vfStorage: { uploadFile: vi.fn(async () => ({ url: 'u', path: 'p' })) },
}));
vi.mock('@/modules/accounting/services/core/ocrService', () => ({
  extractFromImage: m.extractFromImage, extractFromPdf: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/vlmService', () => ({ isVlmAvailable: () => true }));
vi.mock('@/modules/accounting/services/ar/invoicePdfService', () => ({ generateInvoicePdf: vi.fn(async () => Buffer.from('%PDF')) }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'm1' })),
}));
vi.mock('@/modules/accounting/services/core/webhookService', () => ({ fireWebhook: m.fireWebhook }));
vi.mock('@/modules/accounting/services/budgets/drivers/budgetRollJob', () => ({ runBudgetRolls: m.runBudgetRolls }));
// The period paths queue the automatic snapshot too; its work is not under test here.
vi.mock('@/modules/accounting/services/audit/autoSnapshot', () => ({ runAutoSnapshots: vi.fn(async () => undefined) }));

import type { RequestContext } from '@/lib/als';
import { drainAfterCommit, runOwnedContext } from '@/lib/afterCommit';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { uploadDocument } from '@/modules/accounting/services/core/documentStorageService';
import { sendInvoiceEmail } from '@/modules/accounting/services/core/emailNotificationService';
import { closePeriod, closeYear, lockPeriod } from '@/modules/accounting/services/gl/fiscalPeriodService';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tmp = mkdtempSync(path.join(tmpdir(), 'r075-'));
const png = path.join(tmp, 'doc.png');
writeFileSync(png, Buffer.from('89504e47', 'hex'));

const res = () => ({ statusCode: 200, headersSent: false, setHeader() {}, status(c: number) { this.statusCode = c; return this; }, json() {} });

/** Each site, and the background call it must not start before COMMIT. */
const sites: Array<[string, () => Promise<unknown>, () => unknown[]]> = [
  ['withFlowMeter → recalculateNudge',
    () => withFlowMeter('invoice.create', 1)(async (_req: unknown, r: ReturnType<typeof res>) => { r.statusCode = 200; })(
      { companyId: COMPANY, user: { id: 'u' } } as never, res() as never),
    () => m.recalculateNudge.mock.calls],
  ['uploadDocument → VLM extraction',
    () => uploadDocument({ companyId: COMPANY, entityType: 'purchase_order', entityId: 'e1', documentType: 'other', filePath: png,
      mimeType: 'image/png', size: 4, originalFilename: 'doc.png', uploadedBy: 'u', uploadedByName: 'U' }),
    () => m.extractFromImage.mock.calls],
  ['sendInvoiceEmail → invoice.sent webhook',
    () => sendInvoiceEmail(COMPANY, 'inv-1', 'client@example.test'),
    () => m.fireWebhook.mock.calls],
];

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockImplementation(async () => [{ id: 'doc-1', invoice_number: 'INV-1', total_amount: 10, name: 'Co',
    uploaded_at: '2026-09-10T08:00:00.000Z', uploaded_by: 'u', file_name: 'doc.png', file_size: 4, is_active: true }]);
});

describe.each(sites)('%s', (_name, run, calls) => {
  it('inside a request: queued, not started until the owner drains after COMMIT', async () => {
    const ctx = { client: { query: vi.fn() }, userId: 'u', companyId: COMPANY, claims: {}, afterCommit: [] } as unknown as RequestContext;
    await runOwnedContext(ctx, async () => { await run(); });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls()).toHaveLength(0);
    drainAfterCommit(ctx);
    await new Promise((r) => setTimeout(r, 5));
    expect(calls()).toHaveLength(1);
  });

  it('outside a request (cron, webhook): starts at once, as before', async () => {
    await run();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls()).toHaveLength(1);
  });
});

/**
 * Budgets P4 §6: closing or locking a period, or closing a year, queues the rolling-forecast roll
 * (scheduleBudgetRoll) after COMMIT, as the closer, once per request with every end date. Outside
 * a request there is no principal to roll as: nothing is queued or started, and the close succeeds.
 */
describe('fiscal period close paths → rolling forecast roll', () => {
  const period = { id: 'p1', period_name: 'P1', period_number: 1, fiscal_year: 2027, start_date: '2026-03-01', end_date: '2026-03-31', cnt: 0 };
  const paths: Array<[string, () => Promise<unknown>, string]> = [
    ['closePeriod', () => closePeriod(COMPANY, 'p1', 'u'), 'open'],
    ['lockPeriod', () => lockPeriod(COMPANY, 'p1'), 'closed'],
    ['closeYear', () => closeYear(COMPANY, 2027, 'u'), 'open'],
  ];

  it.each(paths)('%s: queued, not started until the owner drains after COMMIT', async (_name, run, status) => {
    m.sql.mockImplementation(async () => [{ ...period, status }]);
    const ctx = { client: { query: vi.fn() }, userId: 'u', companyId: COMPANY, claims: { sub: 'u' }, afterCommit: [] } as unknown as RequestContext;
    await runOwnedContext(ctx, async () => { await run(); });
    await new Promise((r) => setTimeout(r, 5));
    expect(m.runBudgetRolls).not.toHaveBeenCalled();
    expect(ctx.afterCommit!.map((j) => j.label)).toContain('budget-rolling-forecast');
    drainAfterCommit(ctx);
    await vi.waitFor(() => expect(m.runBudgetRolls).toHaveBeenCalledTimes(1));
    expect(m.runBudgetRolls).toHaveBeenCalledWith({ userId: 'u', companyId: COMPANY, claims: { sub: 'u' } }, ['2026-03-31']);
  });

  it('outside a request: the close succeeds and no roll is queued or started', async () => {
    m.sql.mockImplementation(async () => [{ ...period, status: 'open' }]);
    await expect(closePeriod(COMPANY, 'p1', 'u')).resolves.toMatchObject({ endDate: '2026-03-31' });
    await new Promise((r) => setTimeout(r, 5));
    expect(m.runBudgetRolls).not.toHaveBeenCalled();
  });
});
