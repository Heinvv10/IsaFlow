/**
 * R-185: postGatewayFee decides by OUTCOME when its create+post fails. The fee journal is guarded
 * by a partial unique index (migration 852); a concurrent delivery that posted first makes this
 * one's insert raise 23505. Whatever the error, the fee journal is re-read: present means another
 * delivery posted it (stand down), absent means the original error is the answer (rethrow it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ guardRows: [] as unknown[][], savepoints: [] as string[], inSavepoint: false, calledIn: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => h.guardRows.shift() ?? []),
  withSavepoint: vi.fn(async (name: string, fn: () => Promise<unknown>) => {
    h.savepoints.push(name);
    h.inSavepoint = true;
    try { return await fn(); } finally { h.inSavepoint = false; }
  }),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn(async () => ({ id: 'exp-1' })) }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { postGatewayFee } from '@/modules/accounting/services/ar/gatewayFeeService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const create = createJournalEntry as unknown as ReturnType<typeof vi.fn>;
const post = postJournalEntry as unknown as ReturnType<typeof vi.fn>;
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const receipt = { companyId: 'co-1', invoiceId: 'inv-1', reference: 'r185_ref', requestedCents: 11500,
  reported: { amountCents: 11500, currency: 'ZAR' }, feeRand: 3 };

/** What node-postgres raises for the index, as captured from the fixture (docs/audits/remediation/R-185/pg-23505.shape.log). */
function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint "ux_gl_je_gateway_fee_reference"'), {
    name: 'error', code: '23505', severity: 'ERROR', schema: 'public', table: 'gl_journal_entries',
    constraint: 'ux_gl_je_gateway_fee_reference',
    detail: 'Key (company_id, reference)=(00000000-0000-0000-0000-000000000001, r185_ref) already exists.',
  });
}

beforeEach(() => {
  h.guardRows = [];
  h.savepoints = [];
  h.calledIn = [];
  // Records whether each call ran inside the savepoint callback.
  create.mockReset().mockImplementation(async () => { h.calledIn.push(`create:${h.inSavepoint}`); return { id: 'je-fee' }; });
  post.mockReset().mockImplementation(async () => { h.calledIn.push(`post:${h.inSavepoint}`); });
  sqlMock.mockClear();
  vi.mocked(log.info).mockClear();
  vi.mocked(log.warn).mockClear();
});

describe('postGatewayFee when the create+post fails', () => {
  it('23505 and the fee journal now exists: stands down without throwing', async () => {
    create.mockRejectedValueOnce(uniqueViolation());
    h.guardRows = [[], [{ id: 'je-winner' }]]; // the guard finds nothing; the re-read finds the winner
    await expect(postGatewayFee(receipt, 'user-1', 'bank-1', '2026-10-03')).resolves.toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('Gateway fee already posted by a concurrent delivery', {
      reference: 'r185_ref', fee: 3, code: '23505',
      error: 'duplicate key value violates unique constraint "ux_gl_je_gateway_fee_reference"',
    }, 'accounting');
  });

  it('any error, not only 23505 (a 40P01 from the post), with the journal present: stands down', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { name: 'error', code: '40P01', severity: 'ERROR' }));
    h.guardRows = [[], [{ id: 'je-winner' }]];
    await expect(postGatewayFee(receipt, 'user-1', 'bank-1', '2026-10-03')).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith('Gateway fee already posted by a concurrent delivery',
      { reference: 'r185_ref', fee: 3, code: '40P01', error: 'deadlock detected' }, 'accounting');
  });

  it('a thrown null with the journal present: stands down, no TypeError reading its code', async () => {
    create.mockRejectedValueOnce(null);
    h.guardRows = [[], [{ id: 'je-winner', status: 'posted' }]];
    await expect(postGatewayFee(receipt, 'user-1', 'bank-1', '2026-10-03')).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith('Gateway fee already posted by a concurrent delivery',
      { reference: 'r185_ref', fee: 3, code: undefined, error: 'null' }, 'accounting');
  });

  it('a thrown null with no fee journal on re-read: rethrows the null itself', async () => {
    create.mockRejectedValueOnce(null);
    h.guardRows = [[], []];
    await expect(postGatewayFee(receipt, 'user-1', 'bank-1', '2026-10-03')).rejects.toBeNull();
  });

  it('the row found is a DRAFT: stands down (same semantics) but warns that it is a draft, not posted', async () => {
    create.mockRejectedValueOnce(uniqueViolation());
    h.guardRows = [[], [{ id: 'je-draft', status: 'draft' }]];
    await expect(postGatewayFee(receipt, 'user-1', 'bank-1', '2026-10-03')).resolves.toBeUndefined();
    expect(log.info).not.toHaveBeenCalledWith('Gateway fee already posted by a concurrent delivery', expect.anything(), 'accounting');
    expect(log.warn).toHaveBeenCalledWith('Gateway fee not posted — a DRAFT fee journal already holds the reference',
      expect.objectContaining({ reference: 'r185_ref', journalEntryId: 'je-draft', code: '23505' }), 'accounting');
  });

  it('23505 but no fee journal on re-read: rethrows the original error', async () => {
    const err = uniqueViolation();
    create.mockRejectedValueOnce(err);
    h.guardRows = [[], []];
    await expect(postGatewayFee(receipt, 'user-1', 'bank-1', '2026-10-03')).rejects.toBe(err);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('a post failure (not a 23505) with no fee journal on re-read: rethrows it', async () => {
    const err = Object.assign(new Error('Cannot post to a closed fiscal period'), { name: 'ClosedFiscalPeriodError' });
    post.mockRejectedValueOnce(err);
    h.guardRows = [[], []];
    await expect(postGatewayFee(receipt, 'user-1', 'bank-1', '2026-10-03')).rejects.toBe(err);
  });

  it('runs the create and the post inside one savepoint', async () => {
    h.guardRows = [[]];
    await postGatewayFee(receipt, 'user-1', 'bank-1', '2026-10-03');
    expect(h.savepoints).toEqual(['gateway_fee_post']);
    expect(h.calledIn).toEqual(['create:true', 'post:true']);
  });
});
