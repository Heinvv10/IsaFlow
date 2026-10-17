/**
 * The HTTP face of the statement read: retry and delete answer 404 for a statement that is not
 * there, 409 for one that cannot be retried or deleted, and the success body otherwise. The
 * refusals are decided before any write, so the 4xx loses nothing (withAuth commits a 4xx).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withWriteAccess', () => ({ withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const m = vi.hoisted(() => {
  class ImportNotReadyError extends Error {}
  class ReconciliationNotReadyError extends Error {}
  class ReconciliationClosedError extends Error {}
  return {
    retryImport: vi.fn(), deleteFailedImport: vi.fn(), getImport: vi.fn(), commitImport: vi.fn(), rollbackImport: vi.fn(),
    retryReconciliation: vi.fn(), deleteFailedReconciliation: vi.fn(), getReconciliation: vi.fn(),
    rematchLines: vi.fn(), markReconciled: vi.fn(),
    ImportNotReadyError, ReconciliationNotReadyError, ReconciliationClosedError,
  };
});
vi.mock('@/modules/accounting/services/bank/bankStatementOcrService', () => ({
  retryImport: m.retryImport, deleteFailedImport: m.deleteFailedImport, getImport: m.getImport,
  commitImport: m.commitImport, rollbackImport: m.rollbackImport, ImportNotReadyError: m.ImportNotReadyError,
}));
vi.mock('@/modules/accounting/services/capture/supplierStatementLifecycle', () => ({
  retryReconciliation: m.retryReconciliation, deleteFailedReconciliation: m.deleteFailedReconciliation,
}));
vi.mock('@/modules/accounting/services/capture/supplierStatementReconService', () => ({
  getReconciliation: m.getReconciliation, rematchLines: m.rematchLines, markReconciled: m.markReconciled,
  ReconciliationNotReadyError: m.ReconciliationNotReadyError, ReconciliationClosedError: m.ReconciliationClosedError,
}));

import { ExtractionActionRefusedError } from '@/modules/accounting/services/bank/statementExtractionState';
import bankRetry from '../../../pages/api/accounting/bank-statements/[id]/retry';
import bankItem from '../../../pages/api/accounting/bank-statements/[id]/index';
import supplierRetry from '../../../pages/api/accounting/supplier-statements/[id]/retry';
import supplierItem from '../../../pages/api/accounting/supplier-statements/[id]/index';
import bankCommit from '../../../pages/api/accounting/bank-statements/[id]/commit';
import bankRollback from '../../../pages/api/accounting/bank-statements/[id]/rollback';
import supplierRematch from '../../../pages/api/accounting/supplier-statements/[id]/rematch';
import supplierReconcile from '../../../pages/api/accounting/supplier-statements/[id]/mark-reconciled';

const CO = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';

type Handler = (q: unknown, s: unknown) => Promise<void>;
async function call(handler: unknown, method: string): Promise<{ statusCode: number; body: unknown }> {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  await (handler as Handler)({ method, query: { id: ID }, companyId: CO, user: { id: 'u' } }, res);
  return state;
}

const refusals: Array<[string, ExtractionActionRefusedError, number]> = [
  ['not found', new ExtractionActionRefusedError('NOT_FOUND', 'Statement not found.'), 404],
  ['still being read', new ExtractionActionRefusedError('IN_PROGRESS', 'This statement is still being read.'), 409],
  ['not retryable', new ExtractionActionRefusedError('NOT_RETRYABLE', 'Too long. It cannot be retried.'), 409],
  ['not failed', new ExtractionActionRefusedError('NOT_FAILED', 'Only a failed one.'), 409],
];

beforeEach(() => { vi.clearAllMocks(); });

describe.each([
  ['bank retry', bankRetry, 'POST', m.retryImport],
  ['supplier retry', supplierRetry, 'POST', m.retryReconciliation],
  ['bank delete', bankItem, 'DELETE', m.deleteFailedImport],
  ['supplier delete', supplierItem, 'DELETE', m.deleteFailedReconciliation],
])('%s', (_name, handler, method, service) => {
  it('hands the company and id to the service, and answers 200 with what it returns', async () => {
    service.mockResolvedValue({ id: ID, status: 'extracting' });
    const out = await call(handler, method);
    expect(service).toHaveBeenCalledWith(CO, ID);
    expect(out.statusCode).toBe(200);
  });

  it.each(refusals)('answers a refusal "%s" with its status, and the message', async (_label, err, status) => {
    service.mockRejectedValue(err);
    const out = await call(handler, method);
    expect(out.statusCode).toBe(status);
    if (status === 409) expect(JSON.stringify(out.body)).toContain(err.message);
  });

  it('does not swallow any other error', async () => {
    service.mockRejectedValue(new Error('db down'));
    await expect(call(handler, method)).rejects.toThrow('db down');
  });
});

describe.each([['bank retry', bankRetry], ['supplier retry', supplierRetry]])('%s method', (_n, handler) => {
  it('is POST only', async () => {
    expect((await call(handler, 'GET')).statusCode).toBe(405);
  });
});

describe.each([
  ['bank commit', bankCommit, m.commitImport, m.ImportNotReadyError],
  ['bank rollback', bankRollback, m.rollbackImport, m.ImportNotReadyError],
  ['supplier rematch', supplierRematch, m.rematchLines, m.ReconciliationNotReadyError],
  ['supplier mark-reconciled', supplierReconcile, m.markReconciled, m.ReconciliationNotReadyError],
])('%s on a statement that is still being read, or failed', (_name, handler, service, NotReady) => {
  it('answers 409 with the reason, not 500', async () => {
    service.mockRejectedValue(new NotReady('This statement is still being read.'));
    const out = await call(handler, 'POST');
    expect(out.statusCode).toBe(409);
    expect(JSON.stringify(out.body)).toContain('still being read');
  });

  it('does not swallow any other error', async () => {
    service.mockRejectedValue(new Error('db down'));
    await expect(call(handler, 'POST')).rejects.toThrow('db down');
  });
});
