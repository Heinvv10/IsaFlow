/**
 * WP7: a malformed id is a 400 before any query or service call (it used to reach a ::UUID cast and answer 500).
 * rules-preview bankAccountId, bank-feeds/[id] (+ sync, logs), bank-statements/[id] (+ commit, retry, rollback),
 * bank-auto-post undo runId. A real UUID gets past the check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BAD_IDS, UUID_A, callRoute } from '../helpers/apiRouteCall';

const touched = vi.fn();
const service = () => touched();
vi.mock('@/lib/neon', () => ({ sql: Object.assign(async () => { touched(); return [{ cnt: 0 }]; }, { unsafe: (s: string) => s }), withSavepoint: async (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/openBankingService', () => ({
  deleteBankFeedConnection: async () => { service(); }, syncBankFeed: async () => { service(); return {}; },
  getBankFeedSyncLogs: async () => { service(); return []; }, BankFeedProviderNotImplementedError: class extends Error {},
  listBankFeedConnections: async () => [], createBankFeedConnection: async () => ({}),
}));
vi.mock('@/modules/accounting/services/bank/bankStatementOcrService', () => ({
  getImport: async () => { service(); return null; }, deleteFailedImport: async () => { service(); },
  commitImport: async () => { service(); return {}; }, retryImport: async () => { service(); return {}; },
  rollbackImport: async () => { service(); }, ImportNotReadyError: class extends Error {},
  createImportFromDocument: vi.fn(), listImports: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankMatchCandidatesService', () => ({
  fetchBankTransaction: async () => { service(); return { id: 'x' }; }, getMatchCandidates: async () => ({ candidates: [] }),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  getReconciliations: async () => { service(); return []; }, getReconciliationById: async () => { service(); return { id: 'r' }; }, startReconciliation: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAccountGuard', () => ({ assertBankAccountInCompany: vi.fn(), isBankAccountGuardRefusal: () => false }));
vi.mock('@/modules/accounting/services/bank/autoPostUndoService', () => ({ undoRun: async () => { service(); return {}; }, markCorrectedByHand: vi.fn(), undoAnyway: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/autoPostGateService', () => ({ getAutoPostSettings: vi.fn(), updateAutoPostSettings: vi.fn(), autoPostRunSnapshot: vi.fn() }));

import rulesPreview from '../../../pages/api/accounting/bank-rules-preview';
import feedById from '../../../pages/api/accounting/bank-feeds/[id]';
import feedSync from '../../../pages/api/accounting/bank-feeds/[id]/sync';
import feedLogs from '../../../pages/api/accounting/bank-feeds/[id]/logs';
import stmtIndex from '../../../pages/api/accounting/bank-statements/[id]/index';
import stmtCommit from '../../../pages/api/accounting/bank-statements/[id]/commit';
import stmtRetry from '../../../pages/api/accounting/bank-statements/[id]/retry';
import stmtRollback from '../../../pages/api/accounting/bank-statements/[id]/rollback';
import autoPost from '../../../pages/api/accounting/bank-auto-post';
import matchCandidates from '../../../pages/api/accounting/bank-match-candidates';
import reconciliations from '../../../pages/api/accounting/bank-reconciliations';

beforeEach(() => { touched.mockReset(); });

const ID_ROUTES: Array<[string, unknown, string, Record<string, unknown>]> = [
  ['bank-feeds/[id] DELETE', feedById, 'DELETE', {}],
  ['bank-feeds/[id]/sync POST', feedSync, 'POST', {}],
  ['bank-feeds/[id]/logs GET', feedLogs, 'GET', {}],
  ['bank-statements/[id] GET', stmtIndex, 'GET', {}],
  ['bank-statements/[id] DELETE', stmtIndex, 'DELETE', {}],
  ['bank-statements/[id]/commit POST', stmtCommit, 'POST', {}],
  ['bank-statements/[id]/retry POST', stmtRetry, 'POST', {}],
  ['bank-statements/[id]/rollback POST', stmtRollback, 'POST', {}],
];

describe.each(ID_ROUTES)('%s', (_name, handler, method) => {
  it.each(BAD_IDS)('id %s is a 400 and nothing runs', async (bad) => {
    const r = await callRoute(handler, { method, query: { id: bad } });
    expect(r.code).toBe(400);
    expect(touched).not.toHaveBeenCalled();
  });

  it('a repeated id (an array) is a 400 too', async () => {
    expect((await callRoute(handler, { method, query: { id: [UUID_A, UUID_A] } })).code).toBe(400);
    expect(touched).not.toHaveBeenCalled();
  });

  it('an uppercase or seeded (non-v4) id is accepted: the check is a GUID check, not RFC 4122 version/variant', async () => {
    for (const id of [UUID_A.toUpperCase(), '00000000-0000-0000-0000-000000000001']) {
      expect((await callRoute(handler, { method, query: { id } })).code, id).not.toBe(400);
    }
  });

  it('a real UUID gets past the check and reaches the service', async () => {
    const r = await callRoute(handler, { method, query: { id: UUID_A } });
    expect(r.code).not.toBe(400);
    expect(touched).toHaveBeenCalled();
  });
});

describe('bank-rules-preview', () => {
  it.each(BAD_IDS)('bankAccountId %s is a 400 and nothing is counted', async (bad) => {
    expect((await callRoute(rulesPreview, { query: { pattern: 'woolies', bankAccountId: bad } })).code).toBe(400);
    expect(touched).not.toHaveBeenCalled();
  });
  it('a UUID, or none, counts', async () => {
    expect((await callRoute(rulesPreview, { query: { pattern: 'woolies', bankAccountId: UUID_A } })).code).toBe(200);
    expect((await callRoute(rulesPreview, { query: { pattern: 'woolies' } })).code).toBe(200);
  });
});

describe('bank-match-candidates', () => {
  it.each([...BAD_IDS, ''])('bankTransactionId %j is a 400 and nothing is read', async (bad) => {
    expect((await callRoute(matchCandidates, { query: { bankTransactionId: bad } })).code).toBe(400);
    expect(touched).not.toHaveBeenCalled();
  });
  it('a repeated one is a 400; a UUID reads', async () => {
    expect((await callRoute(matchCandidates, { query: { bankTransactionId: [UUID_A, UUID_A] } })).code).toBe(400);
    expect(touched).not.toHaveBeenCalled();
    expect((await callRoute(matchCandidates, { query: { bankTransactionId: UUID_A } })).code).toBe(200);
  });
});

describe('bank-reconciliations GET', () => {
  it.each(BAD_IDS.flatMap((b) => [['id', b], ['bank_account_id', b]]))('%s=%s is a 400 and nothing is read', async (key, bad) => {
    expect((await callRoute(reconciliations, { query: { [key as string]: bad } })).code).toBe(400);
    expect(touched).not.toHaveBeenCalled();
  });
  it('repeated parameters are a 400; UUIDs and none read', async () => {
    expect((await callRoute(reconciliations, { query: { id: [UUID_A, UUID_A] } })).code).toBe(400);
    expect((await callRoute(reconciliations, { query: { bank_account_id: UUID_A } })).code).toBe(200);
    expect((await callRoute(reconciliations, { query: {} })).code).toBe(200);
  });
});

describe('bank-auto-post undo', () => {
  it.each(BAD_IDS)('runId %s is a 400 and nothing is undone', async (bad) => {
    const r = await callRoute(autoPost, { method: 'POST', body: { action: 'undo', runId: bad } });
    expect(r.code).toBe(400);
    expect(touched).not.toHaveBeenCalled();
  });
  it('a UUID runId reaches undoRun', async () => {
    const r = await callRoute(autoPost, { method: 'POST', body: { action: 'undo', runId: UUID_A } });
    expect(r.code).toBe(200);
    expect(touched).toHaveBeenCalled();
  });
});
