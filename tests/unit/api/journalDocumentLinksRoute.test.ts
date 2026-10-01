/**
 * /api/accounting/journal-document-links — no extra role (same write
 * permission as any other journal edit, matching journal-entries-action.ts).
 * Service refusals are pinned in journalDocumentLinkService.test.ts; this
 * file is the route wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

const m = vi.hoisted(() => ({
  linkDocumentToJournal: vi.fn(),
  unlinkDocumentFromJournal: vi.fn(),
  getActiveLinksForJournal: vi.fn(),
  listLinkableDocuments: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalDocumentLinkService', () => {
  class JournalDocumentLinkRefusal extends Error {}
  return { ...m, JournalDocumentLinkRefusal };
});

import handler from '../../../pages/api/accounting/journal-document-links';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const JOURNAL = 'cccccccc-0000-4000-8000-cccccccccccc';
const DOC = 'dddddddd-0000-4000-8000-dddddddddddd';

type Out = { kind: string; [k: string]: unknown };

function call(method: string, body: unknown, query: Record<string, unknown> = {}): Promise<Out> {
  const req = { method, body, query, companyId: COMPANY, user: { id: USER } } as unknown as NextApiRequest;
  const res = {} as unknown as NextApiResponse;
  return (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<Out>)(req, res);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.linkDocumentToJournal.mockResolvedValue({ id: 'link-1' });
  m.unlinkDocumentFromJournal.mockResolvedValue(undefined);
  m.getActiveLinksForJournal.mockResolvedValue([]);
  m.listLinkableDocuments.mockResolvedValue([]);
});

describe('GET', () => {
  it('rejects a non-UUID journal_entry_id', async () => {
    const out = await call('GET', undefined, { journal_entry_id: 'not-a-uuid' });
    expect(out.kind).toBe('badRequest');
  });

  it('returns links + candidates, scoped by company', async () => {
    const out = await call('GET', undefined, { journal_entry_id: JOURNAL, q: 'invoice' });
    expect(out.kind).toBe('success');
    expect(m.getActiveLinksForJournal).toHaveBeenCalledWith(COMPANY, JOURNAL);
    expect(m.listLinkableDocuments).toHaveBeenCalledWith(COMPANY, 'invoice');
  });
});

describe('POST', () => {
  it('rejects a blank reason before any service call', async () => {
    const out = await call('POST', { action: 'link', journalEntryId: JOURNAL, capturedDocumentId: DOC, reason: '  ' });
    expect(out.kind).toBe('validationError');
    expect(m.linkDocumentToJournal).not.toHaveBeenCalled();
  });

  it('link dispatches to linkDocumentToJournal with the authenticated user', async () => {
    const out = await call('POST', { action: 'link', journalEntryId: JOURNAL, capturedDocumentId: DOC, reason: 'Invoice attached' });
    expect(out.kind).toBe('success');
    expect(m.linkDocumentToJournal).toHaveBeenCalledWith(COMPANY, JOURNAL, DOC, USER, 'Invoice attached');
  });

  it('unlink dispatches to unlinkDocumentFromJournal', async () => {
    const out = await call('POST', { action: 'unlink', journalEntryId: JOURNAL, capturedDocumentId: DOC, reason: 'Wrong doc' });
    expect(out.kind).toBe('success');
    expect(m.unlinkDocumentFromJournal).toHaveBeenCalledWith(COMPANY, JOURNAL, DOC, USER, 'Wrong doc');
  });

  it('maps a service refusal to 400', async () => {
    const { JournalDocumentLinkRefusal } = await import('@/modules/accounting/services/gl/journalDocumentLinkService') as unknown as { JournalDocumentLinkRefusal: new (m: string) => Error };
    m.linkDocumentToJournal.mockRejectedValue(new JournalDocumentLinkRefusal('Journal entry not found, not posted, or reversed.'));
    const out = await call('POST', { action: 'link', journalEntryId: JOURNAL, capturedDocumentId: DOC, reason: 'x' });
    expect(out).toMatchObject({ kind: 'badRequest' });
  });
});

it('rejects an unsupported method', async () => {
  const out = await call('DELETE', undefined);
  expect(out.kind).toBe('methodNotAllowed');
});
