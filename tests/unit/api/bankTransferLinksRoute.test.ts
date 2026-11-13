/**
 * /api/accounting/bank-transfer-links (migration 978): the transfer link log and its undo. Only `withAuth` is
 * stubbed (to set the role and user); the real `withWriteAccess` gate is in the route's wrapper chain, so a viewer
 * may read the log but never undo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ list: vi.fn(), undo: vi.fn(), role: 'viewer' }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async () => {
  const real = await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess');
  return {
    withWriteAccess: real.withWriteAccess,
    withAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) =>
      (req: NextApiRequest, res: NextApiResponse) =>
        h(Object.assign(req, { companyRole: mocks.role, user: { id: 'user-1', email: 'u@example.test' } }), res),
  };
});
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/bank/bankTransferLinkLog', () => ({ listTransferLinks: mocks.list }));
vi.mock('@/modules/accounting/services/bank/bankTransferLinkUndo', async () => {
  const real = await vi.importActual<typeof import('@/modules/accounting/services/bank/bankTransferLinkUndo')>(
    '@/modules/accounting/services/bank/bankTransferLinkUndo');
  return { TransferLinkUndoError: real.TransferLinkUndoError, undoTransferLinks: mocks.undo };
});

import handler from '../../../pages/api/accounting/bank-transfer-links';
import { TransferLinkUndoError } from '@/modules/accounting/services/bank/bankTransferLinkUndo';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';

const CO = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';
const BATCH = '33333333-3333-4333-8333-333333333333';
const LINK = '44444444-4444-4444-8444-444444444444';

async function call(role: string, method: string, opts: { body?: unknown; query?: Record<string, string> } = {}) {
  mocks.role = role;
  const res = {
    statusCode: 0, body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader: vi.fn(),
  };
  await handler(
    { method, companyId: CO, body: opts.body, query: opts.query ?? {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}
const messageOf = (body: unknown) => (body as { error?: { message?: string } }).error?.message;

describe('bank-transfer-links route', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue([]);
    mocks.undo.mockReset().mockResolvedValue({ undone: 1, refused: 0 });
  });

  it('lets a viewer read the log for one bank account', async () => {
    const res = await call('viewer', 'GET', { query: { bankAccountId: BANK } });
    expect(res.statusCode).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(CO, BANK);
  });

  it('refuses a GET without a valid bankAccountId', async () => {
    const res = await call('viewer', 'GET', { query: { bankAccountId: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(messageOf(res.body)).toBe('bankAccountId is required');
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('refuses a viewer undo with 403 and never runs it', async () => {
    const res = await call('viewer', 'POST', { body: { action: 'undo', batchId: BATCH } });
    expect(res.statusCode).toBe(403);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it('undoes a batch or one link for a manager', async () => {
    expect((await call('manager', 'POST', { body: { action: 'undo', batchId: BATCH } })).statusCode).toBe(200);
    expect(mocks.undo).toHaveBeenLastCalledWith(CO, { batchId: BATCH }, { id: 'user-1', email: 'u@example.test' });
    expect((await call('manager', 'POST', { body: { action: 'undo', linkId: LINK } })).statusCode).toBe(200);
    expect(mocks.undo).toHaveBeenLastCalledWith(CO, { linkId: LINK }, { id: 'user-1', email: 'u@example.test' });
  });

  it('refuses a body naming both ids, neither, or another action (422 validation)', async () => {
    for (const body of [
      { action: 'undo', batchId: BATCH, linkId: LINK }, { action: 'undo' }, { action: 'redo', batchId: BATCH }, undefined,
    ]) {
      expect((await call('manager', 'POST', { body })).statusCode).toBe(422);
    }
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it('answers a changed line 409 with the service sentence, and a missing link 404', async () => {
    mocks.undo.mockRejectedValueOnce(new TransferLinkUndoError('CHANGED', 'This line has changed since it was linked, so the link was not undone.'));
    const changed = await call('manager', 'POST', { body: { action: 'undo', linkId: LINK } });
    expect(changed.statusCode).toBe(409);
    expect(messageOf(changed.body)).toBe('This line has changed since it was linked, so the link was not undone.');

    mocks.undo.mockRejectedValueOnce(new TransferLinkUndoError('NOT_FOUND', 'This transfer link was already undone, or does not exist.'));
    const missing = await call('manager', 'POST', { body: { action: 'undo', linkId: LINK } });
    expect(missing.statusCode).toBe(404);
    expect(messageOf(missing.body)).toBe('This transfer link was already undone, or does not exist.');
  });

  it('answers a held line 503', async () => {
    mocks.undo.mockRejectedValueOnce(new BankTransactionLockTimeoutError('t1'));
    expect((await call('manager', 'POST', { body: { action: 'undo', batchId: BATCH } })).statusCode).toBe(503);
  });

  it('rethrows anything else to the error handler', async () => {
    mocks.undo.mockRejectedValueOnce(new Error('boom'));
    await expect(call('manager', 'POST', { body: { action: 'undo', batchId: BATCH } })).rejects.toThrow('boom');
  });

  it('answers another method 405', async () => {
    expect((await call('manager', 'PUT', { body: {} })).statusCode).toBe(405);
  });
});
