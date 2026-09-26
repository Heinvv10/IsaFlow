/**
 * POST /api/accounting/provisional/[jeId]/attach takes the BANK LINE before the
 * PRE-EXISTING journal — the canonical lock order in
 * `src/modules/accounting/services/bank/.claude.md` — and the captured document
 * last (R-107), after the journal, which is the order `reverseJournalEntry`
 * takes them in (journal, then the release of the document). The capture post
 * paths take the slip FIRST and the bank line after it (the automatic attach);
 * that cycle is made safe, not ordered away — see the header of
 * `provisionalEvidenceAttach.ts` and `r107-auto-attach-savepoint.int.test.ts`.
 *
 * This route is the twin of `capture/evidenceAttachmentService`: both write
 * `bank_transactions` and then `gl_journal_entries`, and both took them the
 * other way round until round 9. Reversed, they are the inverse of every
 * settlement path that holds a bank line and later reaches a journal
 * (`reverseReconciledTransaction`, `voidPaymentDocument`), and the 40P01 that
 * cycle produces reaches the user as a 500 on a money path.
 *
 * The locks, refusals and writes live in `provisionalEvidenceAttach`; the lock
 * helpers and the SQL layer are mocked and every call is logged into one
 * sequence, so the assertion reads the order the real service takes them in.
 * Outcome (races, refusals, the claim) is pinned by
 * `tests/integration/r107-provisional-attach-claim.int.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const events: string[] = [];
const clientQuery = vi.fn(async () => ({ rows: [] }));

vi.mock('@/lib/als', () => ({
  als: { getStore: () => ({ client: { query: clientQuery } }) },
  assertTxUsable: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({
  BankTransactionLockTimeoutError: class extends Error {},
  lockBankTransactionForUpdate: vi.fn(async (_c: string, id: string) => {
    events.push(`lock bank ${id}`);
    return { id };
  }),
}));
vi.mock('@/modules/accounting/services/capture/captureRowLock', () => ({
  CAPTURED_DOCUMENT_REFUSAL_MESSAGE: { already_posted: 'Document already posted', rejected: 'rejected' },
  CaptureRowLockTimeoutError: class extends Error {},
  lockCapturedDocumentForUpdate: vi.fn(async () => {
    events.push('lock document');
    return { status: 'pending', posted_at: null };
  }),
  lockWithTimeout: vi.fn(async (_id: string, read: () => Promise<unknown[]>) => (await read())[0] ?? null),
  claimCapturedDocumentForPosting: vi.fn(async () => {
    events.push('claim document');
    return null;
  }),
}));

import { sql } from '@/lib/neon';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const JE_ID      = '00000000-0000-0000-0000-000000000002';
const DOC_ID     = '00000000-0000-0000-0000-000000000003';
const BANK_TX_ID = '00000000-0000-0000-0000-000000000004';

/** Label each tagged-template statement by what it touches, and answer it. */
function answer(strings: TemplateStringsArray): unknown[] {
  const text = strings.join(' ');
  if (/SELECT id FROM bank_transactions/.test(text)) { events.push('peek bank'); return [{ id: BANK_TX_ID }]; }
  if (/FROM gl_journal_entries[\s\S]*FOR UPDATE/.test(text)) {
    events.push('lock journal');
    return [{ needs_evidence: true, reversed_at: null }];
  }
  if (/source_document_id/.test(text) && /status = 'posted'/.test(text)) {
    events.push('guard: document not already posted');
    return [];
  }
  if (/FROM gl_journal_document_links/.test(text)) {
    events.push('guard: document not already linked');
    return [];
  }
  if (/FROM captured_documents/.test(text)) { events.push('read evidence'); return [{ raw_bytes_sha256: 'h', confidence: '0.9' }]; }
  if (/UPDATE\s+bank_transactions/.test(text)) { events.push('update bank'); return [{ id: BANK_TX_ID }]; }
  if (/UPDATE\s+gl_journal_entries/.test(text)) { events.push('update journal'); return []; }
  throw new Error(`unexpected statement: ${text}`);
}

beforeEach(() => {
  events.length = 0;
  vi.clearAllMocks();
  mockSql.mockImplementation(async (strings: TemplateStringsArray) => answer(strings));
});

describe('provisional evidence attach — canonical lock order', () => {
  it('locks bank line, then journal, then document; claims before the first write; updates bank before journal', async () => {
    const out = await attachDocumentToProvisional(COMPANY_ID, JE_ID, DOC_ID);

    expect(out).toEqual({ kind: 'attached', bankTxId: BANK_TX_ID });
    expect(events).toEqual([
      'peek bank',
      `lock bank ${BANK_TX_ID}`,
      'lock journal',
      'lock document',
      'guard: document not already posted',
      'guard: document not already linked',
      'claim document',
      'read evidence',
      'update bank',
      'update journal',
    ]);
  });
});
