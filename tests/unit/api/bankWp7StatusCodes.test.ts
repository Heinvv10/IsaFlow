/**
 * WP7 status codes:
 *  - bank-relink-transfers: any method but POST is a 405 with Allow (it was a 400 "Method not allowed");
 *  - bank-statements/[id]/commit and /rollback: an import that is not there is a 404 (it threw a bare Error: a 500);
 *  - bank-statements (upload): rate-limited (429, before the body is parsed), and a parser failure is a plain message
 *    that does not echo formidable's text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BAD_IDS, UUID_A, callRoute } from '../helpers/apiRouteCall';

const mocks = vi.hoisted(() => ({ relink: vi.fn(), commit: vi.fn(), rollback: vi.fn(), aiLimit: vi.fn(), parseError: null as null | Error }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(async () => [], { unsafe: (s: string) => s }) }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: (...a: unknown[]) => mocks.aiLimit(...a) }));
vi.mock('@/lib/documentStorage', () => ({ sha256: () => 'h', storeCapturedBytes: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTransferLinkService', () => ({ relinkTransferCounterparts: mocks.relink }));
vi.mock('@/modules/accounting/services/bank/bankAccountGuard', () => ({ assertBankAccountInCompany: vi.fn(), isBankAccountGuardRefusal: () => false }));
vi.mock('@/modules/accounting/services/bank/bankStatementOcrService', async () => {
  const { ExtractionActionRefusedError } = await import('@/modules/accounting/services/bank/statementExtractionState');
  return {
    commitImport: (...a: unknown[]) => mocks.commit(...a), rollbackImport: (...a: unknown[]) => mocks.rollback(...a),
    ImportNotReadyError: class extends Error {}, createImportFromDocument: vi.fn(), listImports: vi.fn(),
    ExtractionActionRefusedError,
  };
});
vi.mock('formidable', () => ({
  default: () => ({ parse: (_req: unknown, cb: (e: unknown, f: unknown, fi: unknown) => void) => cb(mocks.parseError, {}, {}) }),
}));

import relink from '../../../pages/api/accounting/bank-relink-transfers';
import commit from '../../../pages/api/accounting/bank-statements/[id]/commit';
import rollback from '../../../pages/api/accounting/bank-statements/[id]/rollback';
import upload from '../../../pages/api/accounting/bank-statements/index';
import { ExtractionActionRefusedError } from '@/modules/accounting/services/bank/statementExtractionState';

beforeEach(() => {
  mocks.relink.mockReset().mockResolvedValue({ linked: 0, failed: false, batchId: 'b' });
  mocks.commit.mockReset(); mocks.rollback.mockReset();
  mocks.aiLimit.mockReset().mockResolvedValue(true);
  mocks.parseError = null;
});

describe('bank-relink-transfers', () => {
  it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('%s is a 405 naming POST, and no pass runs', async (method) => {
    const r = await callRoute(relink, { method });
    expect(r.code).toBe(405);
    expect(String(r.headers.Allow ?? '')).toContain('POST');
    expect(mocks.relink).not.toHaveBeenCalled();
  });
  it('POST still runs the pass', async () => {
    expect((await callRoute(relink, { method: 'POST', body: { bankAccountId: UUID_A } })).code).toBe(200);
  });
});

describe.each([['commit', commit, 'commit'], ['rollback', rollback, 'rollback']] as const)('bank-statements/[id]/%s', (_n, handler, which) => {
  it('an import that is not there is a 404', async () => {
    mocks[which].mockRejectedValue(new ExtractionActionRefusedError('NOT_FOUND', 'Statement not found.'));
    const r = await callRoute(handler, { method: 'POST', query: { id: UUID_A } });
    expect(r.code).toBe(404);
  });
  it.each(['ALREADY_COMMITTED', 'ROLLED_BACK', 'EVERY_ROW_PRESENT'] as const)('%s is a typed 409, refused before any write (it was a bare Error: a 500)', async (code) => {
    mocks[which].mockRejectedValue(new ExtractionActionRefusedError(code, `refused ${code}`));
    const r = await callRoute(handler, { method: 'POST', query: { id: UUID_A } });
    expect(r.code).toBe(409);
    expect(JSON.stringify(r.body)).toContain(code);
  });

  it('another refusal of the same family is a 409, anything else still throws (a real fault stays a 500)', async () => {
    mocks[which].mockRejectedValue(new ExtractionActionRefusedError('IN_PROGRESS', 'busy'));
    expect((await callRoute(handler, { method: 'POST', query: { id: UUID_A } })).code).toBe(409);
    mocks[which].mockRejectedValue(new Error('db exploded'));
    await expect(callRoute(handler, { method: 'POST', query: { id: UUID_A } })).rejects.toThrow('db exploded');
  });
});

describe('bank-statements upload', () => {
  it('over the AI rate limit is a 429 before the body is parsed', async () => {
    mocks.aiLimit.mockResolvedValue(false);
    mocks.parseError = new Error('would have been parsed');
    const r = await callRoute(upload, { method: 'POST' });
    expect(r.code).toBe(429);
    expect(mocks.aiLimit).toHaveBeenCalledWith(expect.anything(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bank-statements-upload', expect.objectContaining({ ipMax: 30, companyMax: 60, dailyMax: 300 })); // onboarding uploads many statements: generous per company, the IP is the abuse bound
  });

  it("a parser failure is a plain 400 that does not echo formidable's message", async () => {
    mocks.parseError = new Error('options.maxTotalFileSize (123) exceeded at /tmp/formidable_secret_path');
    const r = await callRoute(upload, { method: 'POST' });
    expect(r.code).toBe(400);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/formidable|maxTotalFileSize|\/tmp/);
    expect(text).toMatch(/could not be read/);
  });

  it('an oversize file still says so', async () => {
    mocks.parseError = new Error('maxFileSize exceeded');
    const r = await callRoute(upload, { method: 'POST' });
    expect(r.code).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/too large/i);
  });

  it('GET is not rate-limited', async () => {
    await callRoute(upload, { method: 'GET' });
    expect(mocks.aiLimit).not.toHaveBeenCalled();
  });
});
